import { describe, test, expect, beforeEach, vi } from "vitest";
import type { StoredIdentity, DayFile } from "./storage";
import { runExclusive } from "./serialize";

let identity: StoredIdentity | null = null;
let days: Record<string, DayFile> = {};
let settings: Record<string, string> = {};

// Real storage is async I/O (OPFS, or IndexedDB on older Safari). Any latency
// at all opens the interleaving window; this makes it deterministic.
const tick = () => new Promise((r) => setTimeout(r, 5));

const mockGetEntries = vi.fn();

vi.mock("./storage", () => ({
  saveIdentity: async (i: StoredIdentity) => { identity = structuredClone(i); },
  loadIdentity: async () => (identity ? structuredClone(identity) : null),
  saveDay: async (dayId: string, day: DayFile) => { await tick(); days[dayId] = structuredClone(day); },
  loadDay: async (dayId: string) => { await tick(); return days[dayId] ? structuredClone(days[dayId]) : null; },
  // The real serialisation primitive over an in-memory backend — stubbing the
  // lock here would only test the stub.
  updateDay: (dayId: string, mutate: (day: DayFile) => boolean | Promise<boolean>) =>
    runExclusive(`day:${dayId}`, async () => {
      await tick();
      const day: DayFile = days[dayId] ? structuredClone(days[dayId]) : { entries: [] };
      const changed = await mutate(day);
      if (changed) { await tick(); days[dayId] = structuredClone(day); }
      return changed;
    }),
  listDays: async () => Object.keys(days).sort().reverse(),
  saveSetting: async (k: string, v: string) => { settings[k] = v; },
  loadSetting: async (k: string) => settings[k] ?? null,
  clearAllLocalData: async () => { identity = null; days = {}; settings = {}; },
}));

vi.mock("./relay", () => ({
  getEntries: (...a: unknown[]) => mockGetEntries(...a),
  ackEntries: async () => ({ status: 200, data: { acknowledged: 0 } }),
}));
// A real enough outbox: the edit path depends on a pending item being visible
// to the sync, which an always-empty stub would hide.
let outbox: Array<{ id: string; dayId: string; payloadB64: string }> = [];
vi.mock("./outbox", () => ({
  enqueue: async (dayId: string, payloadB64: string) => {
    outbox.push({ id: `${dayId}-${outbox.length}`, dayId, payloadB64 });
  },
  replaceForDayId: async (dayId: string, payloadB64: string) => {
    const item = outbox.find((i) => i.dayId === dayId);
    if (!item) return false;
    item.payloadB64 = payloadB64;
    return true;
  },
  peekAll: async () => outbox.slice(),
  remove: async (id: string) => { outbox = outbox.filter((i) => i.id !== id); },
}));
vi.mock("./sync", () => ({ flushOutbox: async () => {}, requestBackgroundSync: async () => {} }));
vi.mock("./backup", () => ({ refreshRecoveryBackup: async () => {} }));

const {
  createIdentity,
  completeInitiatorPairing,
  fetchAndDecryptEntries,
  submitEntry,
  updateEntry,
  publicKey,
  secretKey,
} = await import("./store");
const crypto = await import("./crypto");

const DAY = "2026-09-06";

beforeEach(async () => {
  identity = null;
  days = {};
  settings = {};
  outbox = [];
  mockGetEntries.mockReset();
  await crypto.init();
});

async function pairedIdentity() {
  await createIdentity("passphrase");
  const partner = crypto.generateKeyPair();
  await completeInitiatorPairing(crypto.toBase64(partner.publicKey));
  return crypto.computeSharedSecret(secretKey()!, publicKey()!, partner.publicKey);
}

function relayHas(ss: Uint8Array, rows: Array<{ author: "me" | "partner"; text: string; timestamp: string }>) {
  mockGetEntries.mockResolvedValue({
    status: 200,
    data: {
      entries: rows.map((r, i) => ({
        id: `row-${i}`,
        dayId: DAY,
        author: r.author,
        payload: crypto.toBase64(
          crypto.encrypt(
            JSON.stringify({ text: r.text, format: "markdown", timestamp: r.timestamp }),
            ss
          )
        ),
      })),
      nextChangedSince: "2026-09-06T12:00:00Z",
    },
  });
}

const authorsIn = () => (days[DAY]?.entries ?? []).map((e) => e.author).sort();
const payloadOf = (author: string) =>
  days[DAY]?.entries.find((e) => e.author === author)?.payload;

describe("a sync cannot drop what is already on the device", () => {
  test("a poll landing mid-write keeps both entries", async () => {
    // The 30s foreground poll fires while the user is submitting. Both paths
    // load the day, change it, and save. Unserialised, the second save writes
    // back a snapshot taken before the first, and one entry silently vanishes.
    const ss = await pairedIdentity();
    relayHas(ss, [{ author: "partner", text: "partner's words", timestamp: "2026-09-06T10:00:00Z" }]);

    await Promise.all([
      fetchAndDecryptEntries("2026-09-01", { sync: "incremental" }),
      submitEntry("what I wrote today", DAY),
    ]);

    expect(authorsIn()).toEqual(["me", "partner"]);
    expect(payloadOf("me")).toBe("what I wrote today");
    expect(payloadOf("partner")).toBe("partner's words");
  });

  test("two syncs at once keep both entries", async () => {
    // Viewing a day triggers its own fetch, which can overlap the poll.
    const ss = await pairedIdentity();
    relayHas(ss, [
      { author: "partner", text: "theirs", timestamp: "2026-09-06T10:00:00Z" },
      { author: "me", text: "from my other phone", timestamp: "2026-09-06T09:00:00Z" },
    ]);

    await Promise.all([
      fetchAndDecryptEntries("2026-09-01", { sync: "incremental" }),
      fetchAndDecryptEntries(DAY),
    ]);

    expect(authorsIn()).toEqual(["me", "partner"]);
    expect(payloadOf("partner")).toBe("theirs");
  });

  test("an edit mid-poll is not reverted to the copy on the relay", async () => {
    // An edit keeps the entry's original timestamp, so the relay's older copy
    // compares equal rather than older. Serialising means the edit is written
    // after the sync has read, not lost underneath it.
    const ss = await pairedIdentity();
    await submitEntry("first draft", DAY);
    const original = days[DAY].entries.find((e) => e.author === "me")!.timestamp;

    relayHas(ss, [{ author: "me", text: "first draft", timestamp: original }]);

    await Promise.all([
      updateEntry("second thoughts", DAY),
      fetchAndDecryptEntries("2026-09-01", { sync: "incremental" }),
    ]);

    expect(payloadOf("me")).toBe("second thoughts");

    // And still after the poll that follows it, while the edit is queued.
    await fetchAndDecryptEntries("2026-09-01", { sync: "incremental" });
    expect(payloadOf("me")).toBe("second thoughts");
  });

  test("a partner's edit still lands even though it reuses its timestamp", async () => {
    // The rule that protects an undelivered local edit must not also block the
    // partner's — theirs arrives the same shape, equal timestamp and new text.
    const ss = await pairedIdentity();
    relayHas(ss, [{ author: "partner", text: "first version", timestamp: "2026-09-06T10:00:00Z" }]);
    await fetchAndDecryptEntries("2026-09-01", { sync: "incremental" });
    expect(payloadOf("partner")).toBe("first version");

    await submitEntry("mine, undelivered", DAY);
    relayHas(ss, [{ author: "partner", text: "they revised it", timestamp: "2026-09-06T10:00:00Z" }]);
    await fetchAndDecryptEntries("2026-09-01", { sync: "incremental" });

    expect(payloadOf("partner")).toBe("they revised it");
    expect(payloadOf("me")).toBe("mine, undelivered");
  });

  test("a partner entry already held is never removed by a later sync", async () => {
    const ss = await pairedIdentity();
    relayHas(ss, [{ author: "partner", text: "theirs", timestamp: "2026-09-06T10:00:00Z" }]);
    await fetchAndDecryptEntries("2026-09-01", { sync: "incremental" });
    expect(payloadOf("partner")).toBe("theirs");

    // A later poll returns nothing — the cursor says nothing moved. The day
    // file must be left exactly as it was.
    mockGetEntries.mockResolvedValue({
      status: 200,
      data: { entries: [], nextChangedSince: "2026-09-06T13:00:00Z" },
    });
    await fetchAndDecryptEntries("2026-09-01", { sync: "incremental" });
    await submitEntry("mine", DAY);

    expect(authorsIn()).toEqual(["me", "partner"]);
    expect(payloadOf("partner")).toBe("theirs");
  });

  test("an older copy from the relay never replaces a newer local entry", async () => {
    const ss = await pairedIdentity();
    await submitEntry("written here just now", DAY);

    relayHas(ss, [{ author: "me", text: "stale copy", timestamp: "2020-01-01T00:00:00Z" }]);
    await fetchAndDecryptEntries("2026-09-01", { sync: "incremental" });

    expect(payloadOf("me")).toBe("written here just now");
  });
});
