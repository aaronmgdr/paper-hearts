import { describe, test, expect, beforeEach, vi } from "vitest";
import type { StoredIdentity, DayFile } from "./storage";
import { runExclusive } from "./serialize";

// An in-memory stand-in for OPFS/IndexedDB. The bundle logic is what's under
// test here, not the storage backend.
let identity: StoredIdentity | null = null;
let days: Record<string, DayFile> = {};

vi.mock("./storage", () => ({
  saveIdentity: async (i: StoredIdentity) => { identity = structuredClone(i); },
  loadIdentity: async () => (identity ? structuredClone(identity) : null),
  saveDay: async (dayId: string, day: DayFile) => { days[dayId] = structuredClone(day); },
  loadDay: async (dayId: string) => (days[dayId] ? structuredClone(days[dayId]) : null),
  // The real serialisation primitive over the in-memory backend — every day
  // write goes through it.
  updateDay: (dayId: string, mutate: (day: DayFile) => boolean | Promise<boolean>) =>
    runExclusive(`day:${dayId}`, async () => {
      const day: DayFile = days[dayId] ? structuredClone(days[dayId]) : { entries: [] };
      const changed = await mutate(day);
      if (changed) days[dayId] = structuredClone(day);
      return changed;
    }),
  listDays: async () => Object.keys(days).sort().reverse(),
  saveSetting: async () => {},
  loadSetting: async () => null,
  clearAllLocalData: async () => { identity = null; days = {}; },
}));

const { createIdentity, buildAccountBundle, installAccountBundle, unlock, publicKey, isPaired, partnerName, mergeRelayedEntry } =
  await import("./store");
const crypto = await import("./crypto");

beforeEach(async () => {
  identity = null;
  days = {};
  await crypto.init();
});

/** A paired identity with some history, as a device would actually hold it. */
async function seedAccount() {
  await createIdentity("correct horse battery");
  const partner = crypto.generateKeyPair();

  identity!.pairId = "pair-1";
  identity!.partnerPublicKey = crypto.toBase64(partner.publicKey);
  identity!.partnerName = "Robin";
  await unlock("correct horse battery");

  days["2026-08-01"] = {
    entries: [
      { dayId: "2026-08-01", author: "me", payload: "mine", timestamp: "2026-08-01T20:00:00Z" },
      { dayId: "2026-08-01", author: "partner", payload: "theirs", timestamp: "2026-08-01T21:00:00Z" },
    ],
  };
  days["2026-08-02"] = {
    entries: [{ dayId: "2026-08-02", author: "me", payload: "just me", timestamp: "2026-08-02T20:00:00Z" }],
  };

  return { partner };
}

describe("account bundle", () => {
  test("carries the identity, the pairing and the whole diary", async () => {
    const { partner } = await seedAccount();
    const bundle = await buildAccountBundle();

    expect(bundle.v).toBe(1);
    expect(bundle.publicKey).toBe(identity!.publicKey);
    expect(bundle.pairId).toBe("pair-1");
    expect(bundle.partnerPublicKey).toBe(crypto.toBase64(partner.publicKey));
    expect(bundle.partnerName).toBe("Robin");
    expect(bundle.days.map((d) => d.dayId).sort()).toEqual(["2026-08-01", "2026-08-02"]);
  });

  test("round-trips onto an empty device", async () => {
    const { partner } = await seedAccount();
    const bundle = await buildAccountBundle();
    const originalKey = identity!.publicKey;

    // A fresh phone.
    identity = null;
    days = {};

    await installAccountBundle(bundle, "a new device passphrase");

    expect(identity!.publicKey).toBe(originalKey);
    expect(identity!.partnerPublicKey).toBe(crypto.toBase64(partner.publicKey));
    expect(identity!.partnerName).toBe("Robin");
    expect(days["2026-08-01"].entries).toHaveLength(2);
    expect(days["2026-08-02"].entries[0].payload).toBe("just me");
    expect(isPaired()).toBe(true);
    expect(partnerName()).toBe("Robin");

    // The key was re-wrapped under the new device's passphrase, not the old one.
    expect(await unlock("a new device passphrase")).toBe(true);
    expect(await unlock("correct horse battery")).toBe(false);
    expect(crypto.toBase64(publicKey()!)).toBe(originalKey);
  });

  test("installing merges with what is already on the device", async () => {
    // A second phone that has been writing offline must not lose those entries
    // when it adopts the account.
    await seedAccount();
    const bundle = await buildAccountBundle();

    days = {
      "2026-08-03": {
        entries: [
          { dayId: "2026-08-03", author: "me", payload: "written here", timestamp: "2026-08-03T20:00:00Z" },
        ],
      },
    };

    await installAccountBundle(bundle, "device passphrase");

    expect(Object.keys(days).sort()).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(days["2026-08-03"].entries[0].payload).toBe("written here");
  });

  test("the newer of two versions of a day wins", async () => {
    await seedAccount();
    const bundle = await buildAccountBundle();

    days["2026-08-02"] = {
      entries: [
        { dayId: "2026-08-02", author: "me", payload: "stale", timestamp: "2026-08-01T00:00:00Z" },
      ],
    };
    await installAccountBundle(bundle, "device passphrase");
    expect(days["2026-08-02"].entries[0].payload).toBe("just me");

    days["2026-08-02"] = {
      entries: [
        { dayId: "2026-08-02", author: "me", payload: "fresher", timestamp: "2026-09-01T00:00:00Z" },
      ],
    };
    await installAccountBundle(bundle, "device passphrase");
    expect(days["2026-08-02"].entries[0].payload).toBe("fresher");
  });

  test("restoring re-derives the same shared secret as the partner uses", async () => {
    // If this drifted, every entry would arrive undecryptable.
    const { partner } = await seedAccount();
    const bundle = await buildAccountBundle();
    const expected = crypto.computeSharedSecret(
      partner.secretKey,
      partner.publicKey,
      crypto.fromBase64(bundle.publicKey)
    );

    identity = null;
    days = {};
    await installAccountBundle(bundle, "device passphrase");

    const restored = crypto.computeSharedSecret(
      crypto.fromBase64(bundle.secretKey),
      crypto.fromBase64(bundle.publicKey),
      partner.publicKey
    );
    expect(crypto.toBase64(restored)).toBe(crypto.toBase64(expected));
  });

  test("refuses a bundle it doesn't understand", async () => {
    await seedAccount();
    const bundle = await buildAccountBundle();

    await expect(
      installAccountBundle({ ...bundle, v: 2 as unknown as 1 }, "pass")
    ).rejects.toThrow(/different version/i);

    await expect(
      installAccountBundle({ ...bundle, secretKey: "" }, "pass")
    ).rejects.toThrow(/missing its keys/i);
  });
});

describe("mergeRelayedEntry", () => {
  const day = (entries: DayFile["entries"]): DayFile => ({ entries });
  const mine = (payload: string, timestamp: string): DayFile["entries"][0] => ({
    dayId: "2026-09-05",
    author: "me",
    payload,
    timestamp,
  });

  test("adds a missing author", () => {
    const file = day([]);
    expect(mergeRelayedEntry(file, mine("hello", "2026-09-05T12:00:00Z"))).toBe(true);
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0].payload).toBe("hello");
  });

  test("keeps a newer local write instead of an older copy from the other phone", () => {
    const file = day([mine("phone A", "2026-09-05T13:00:00Z")]);
    expect(mergeRelayedEntry(file, mine("phone B earlier", "2026-09-05T12:00:00Z"))).toBe(false);
    expect(file.entries[0].payload).toBe("phone A");
  });

  test("takes the other phone's write when it is newer", () => {
    const file = day([mine("stale", "2026-09-05T12:00:00Z")]);
    expect(mergeRelayedEntry(file, mine("fresh", "2026-09-05T14:00:00Z"))).toBe(true);
    expect(file.entries[0].payload).toBe("fresh");
  });

  test("does not clobber the partner slot when merging own entries", () => {
    const file = day([
      mine("mine", "2026-09-05T12:00:00Z"),
      { dayId: "2026-09-05", author: "partner", payload: "theirs", timestamp: "2026-09-05T12:00:00Z" },
    ]);
    mergeRelayedEntry(file, mine("updated", "2026-09-05T13:00:00Z"));
    expect(file.entries.find((e) => e.author === "partner")?.payload).toBe("theirs");
    expect(file.entries.find((e) => e.author === "me")?.payload).toBe("updated");
  });
});
