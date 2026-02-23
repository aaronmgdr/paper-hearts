import { join } from "path";
import { handleApi } from "./app";
import { handleWsAuth, removeWaiting, type WsData } from "./pairing";

const PORT = parseInt(process.env.PORT || "3000");
const CLIENT_DIST = join(import.meta.dir, "../client/dist");

// In-memory request throttle: 60 req/min per public key
const requestCounts = new Map<string, { count: number; resetAt: number }>();
const THROTTLE_LIMIT = 60;
const THROTTLE_WINDOW_MS = 60 * 1000;

function checkThrottle(publicKey: string | null): boolean {
  if (!publicKey) return true;
  const now = Date.now();
  const entry = requestCounts.get(publicKey);

  if (!entry || now > entry.resetAt) {
    requestCounts.set(publicKey, { count: 1, resetAt: now + THROTTLE_WINDOW_MS });
    return true;
  }

  entry.count++;
  return entry.count <= THROTTLE_LIMIT;
}

const server = Bun.serve<WsData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // WebSocket upgrade for pairing watch
    if (path === "/api/pairs/watch") {
      const upgraded = server.upgrade(req, { data: { pairId: null } });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // API routes
    if (path.startsWith("/api/")) {
      const publicKey = req.headers.get("X-Public-Key");
      const keyShort = publicKey ? publicKey.slice(0, 8) + "…" : "anon";
      console.log(`→ ${req.method} ${path} [${keyShort}]`);

      // Throttle check for authenticated routes
      if (publicKey && !checkThrottle(publicKey)) {
        console.log(`← 429 throttled [${keyShort}]`);
        return Response.json(
          { error: "Too many requests" },
          { status: 429 }
        );
      }

      try {
        const res = await handleApi(req, path);
        console.log(`← ${res.status} ${req.method} ${path} [${keyShort}]`);
        return res;
      } catch (e) {
        console.error(`← 500 ${req.method} ${path} [${keyShort}]`, e);
        return Response.json(
          { error: "Internal server error" },
          { status: 500 }
        );
      }
    }

    // Static file serving (SPA fallback)
    return serveStatic(path);
  },

  websocket: {
    async message(ws, data) {
      try {
        const msg = JSON.parse(data as string);
        if (msg.type === "auth") {
          await handleWsAuth(ws, msg);
        }
      } catch (e) {
        console.error("[watch] WS message parse error:", e);
      }
    },
    close(ws) {
      if (ws.data.pairId) {
        removeWaiting(ws.data.pairId);
        console.log(`[watch] disconnected pairId=${ws.data.pairId}`);
      }
    },
  },
});


async function serveStatic(path: string): Promise<Response> {
  const filePath = join(CLIENT_DIST, path);
  const file = Bun.file(filePath);

  if (await file.exists()) {
    return new Response(file);
  }

  // SPA fallback
  const indexFile = Bun.file(join(CLIENT_DIST, "index.html"));
  if (await indexFile.exists()) {
    return new Response(indexFile);
  }

  return new Response("Not Found", { status: 404 });
}

console.log(`Paper Hearts relay listening on port ${PORT}`);
