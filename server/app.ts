import { initiate, join as joinPair, pairStatus, deleteAccount } from "./routes/pairs";
import { createEntry, getEntries, ackEntries } from "./routes/entries";
import { subscribePush, testPush } from "./routes/push";
import { uploadTransfer, downloadTransfer } from "./routes/transfer";
import {
  startDeviceLink,
  claimDeviceLink,
  getDeviceLink,
  putDeviceLinkPayload,
  getDeviceLinkPayload,
} from "./routes/devicelink";
import { putBackup, getBackup, backupStatus, deleteBackup } from "./routes/backup";

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

  // Moving an account to a second phone
  if (path === "/api/device-link/start" && req.method === "POST") {
    return startDeviceLink(req, path);
  }
  if (path === "/api/device-link/claim" && req.method === "POST") {
    return claimDeviceLink(req);
  }
  if (path === "/api/device-link/payload" && req.method === "POST") {
    return putDeviceLinkPayload(req, path);
  }
  if (path === "/api/device-link/payload" && req.method === "GET") {
    return getDeviceLinkPayload(req);
  }
  if (path === "/api/device-link" && req.method === "GET") {
    return getDeviceLink(req, path + new URL(req.url).search);
  }

  // Recovery backups
  if (path === "/api/backup/status" && req.method === "GET") {
    return backupStatus(req, path);
  }
  if (path === "/api/backup" && req.method === "PUT") {
    return putBackup(req, path);
  }
  if (path === "/api/backup" && req.method === "GET") {
    return getBackup(req);
  }
  if (path === "/api/backup" && req.method === "DELETE") {
    return deleteBackup(req, path);
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
