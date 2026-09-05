import { describe, test, expect, beforeEach, vi } from "vitest";
import type { StoredIdentity, DayFile } from "./storage";

let identity: StoredIdentity | null = null;
let days: Record<string, DayFile> = {};

const mockGetEntries = vi.fn();
const mockAckEntries = vi.fn().mockResolvedValue({ status: 200, data: { acknowledged: 0 } });

vi.mock("./storage", () => ({
  saveIdentity: async (i: StoredIdentity) => { identity = structuredClone(i); },
  loadIdentity: async () => (identity ? structuredClone(identity) : null),
  saveDay: async (dayId: string, day: DayFile) => { days[dayId] = structuredClone(day); },
  loadDay: async (dayId: string) => (days[dayId] ? structuredClone(days[dayId]) : null),
  listDays: async () => Object.keys(days).sort().reverse(),
  saveSetting: async () => {},
  loadSetting: async () => null,
  clearAllLocalData: async () => { identity = null; days = {}; },
}));

vi.mock("./relay", () => ({
  getEntries: (...args: unknown[]) => mockGetEntries(...args),
  ackEntries: (...args: unknown[]) => mockAckEntries(...args),
}));

vi.mock("./outbox", () => ({
  enqueue: async () => {},
  replaceForDayId: async () => false,
  peekAll: async () => [],
}));

vi.mock("./sync", () => ({
  flushOutbox: async () => {},
  requestBackgroundSync: async () => {},
}));

const { createIdentity, completeInitiatorPairing, fetchAndDecryptEntries, publicKey, secretKey } =
  await import("./store");
const crypto = await import("./crypto");

beforeEach(async () => {
  identity = null;
  days = {};
  mockGetEntries.mockReset();
  mockAckEntries.mockClear();
  await crypto.init();
});

describe("fetchAndDecryptEntries — second phone", () => {
  test("installs this account's own relayed write as me, not as partner", async () => {
    await createIdentity("passphrase");
    const partner = crypto.generateKeyPair();
    await completeInitiatorPairing(crypto.toBase64(partner.publicKey));

    const ss = crypto.computeSharedSecret(secretKey()!, publicKey()!, partner.publicKey);
    const timestamp = "2026-09-05T18:00:00Z";
    const sealed = crypto.encrypt(
      JSON.stringify({ text: "wrote this on the other phone", format: "markdown", timestamp }),
      ss
    );

    mockGetEntries.mockResolvedValue({
      status: 200,
      data: {
        entries: [{
          id: "entry-1",
          dayId: "2026-09-05",
          payload: crypto.toBase64(sealed),
          author: "me",
        }],
      },
    });

    await fetchAndDecryptEntries("2026-09-01");

    expect(days["2026-09-05"].entries).toEqual([
      {
        dayId: "2026-09-05",
        author: "me",
        payload: "wrote this on the other phone",
        timestamp,
      },
    ]);
    expect(mockAckEntries).not.toHaveBeenCalled();
  });

  test("acks partner entries and leaves a newer local write in place", async () => {
    await createIdentity("passphrase");
    const partner = crypto.generateKeyPair();
    await completeInitiatorPairing(crypto.toBase64(partner.publicKey));

    days["2026-09-05"] = {
      entries: [{
        dayId: "2026-09-05",
        author: "me",
        payload: "typed here a minute ago",
        timestamp: "2026-09-05T19:00:00Z",
      }],
    };

    const ss = crypto.computeSharedSecret(secretKey()!, publicKey()!, partner.publicKey);
    const mine = crypto.encrypt(
      JSON.stringify({ text: "older copy from the other phone", format: "markdown", timestamp: "2026-09-05T18:00:00Z" }),
      ss
    );
    const theirs = crypto.encrypt(
      JSON.stringify({ text: "partner's words", format: "markdown", timestamp: "2026-09-05T18:30:00Z" }),
      ss
    );

    mockGetEntries.mockResolvedValue({
      status: 200,
      data: {
        entries: [
          { id: "mine", dayId: "2026-09-05", payload: crypto.toBase64(mine), author: "me" },
          { id: "theirs", dayId: "2026-09-05", payload: crypto.toBase64(theirs), author: "partner" },
        ],
      },
    });

    await fetchAndDecryptEntries("2026-09-01");

    const byAuthor = Object.fromEntries(days["2026-09-05"].entries.map((e) => [e.author, e.payload]));
    expect(byAuthor.me).toBe("typed here a minute ago");
    expect(byAuthor.partner).toBe("partner's words");
    expect(mockAckEntries).toHaveBeenCalledWith(["theirs"], publicKey(), secretKey());
  });
});
