import { join } from "path";
import { initiate, join as joinPair, pairStatus, deleteAccount } from "./routes/pairs";
import { createEntry, getEntries, ackEntries } from "./routes/entries";
import { subscribePush } from "./routes/push";

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

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

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
});

async function handleApi(req: Request, path: string): Promise<Response> {
  // Unauthenticated onboarding routes
  if (path === "/api/pairs/initiate" && req.method === "POST") {
    return initiate(req);
  }
  if (path === "/api/pairs/join" && req.method === "POST") {
    return joinPair(req);
  }
  if (path === "/api/pairs/status" && req.method === "GET") {
    return pairStatus(req, path);
  }

  // Authenticated entry routes
  if (path === "/api/entries" && req.method === "POST") {
    return createEntry(req, path);
  }
  if (path === "/api/entries" && req.method === "GET") {
    const fullPath = path + new URL(req.url).search;
    return getEntries(req, fullPath);
  }
  if (path === "/api/entries/ack" && req.method === "POST") {
    return ackEntries(req, path);
  }

  // Push subscription
  if (path === "/api/push/subscribe" && req.method === "POST") {
    return subscribePush(req, path);
  }

  // Account deletion
  if (path === "/api/account" && req.method === "DELETE") {
    return deleteAccount(req, path);
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

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
