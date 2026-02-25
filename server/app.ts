import { initiate, join as joinPair, pairStatus, deleteAccount } from "./routes/pairs";
import { createEntry, getEntries, ackEntries } from "./routes/entries";
import { subscribePush, testPush } from "./routes/push";
import { uploadTransfer, downloadTransfer } from "./routes/transfer";

export async function handleApi(req: Request, path: string): Promise<Response> {
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
  if (path === "/api/push/test" && req.method === "POST") {
    return testPush(req, path);
  }

  // Account deletion
  if (path === "/api/account" && req.method === "DELETE") {
    return deleteAccount(req, path);
  }

  // History transfer (post-pairing device sync)
  if (path === "/api/transfer" && req.method === "POST") {
    return uploadTransfer(req, path);
  }
  if (path === "/api/transfer" && req.method === "GET") {
    return downloadTransfer(req, path);
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
