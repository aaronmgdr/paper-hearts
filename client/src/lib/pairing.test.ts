import { describe, test, expect, beforeEach, vi } from "vitest";
import type { StoredIdentity, DayFile } from "./storage";

let identity: StoredIdentity | null = null;
let days: Record<string, DayFile> = {};
let settings: Record<string, string> = {};

const mockInitiatePair = vi.fn();
const mockJoinPair = vi.fn();

vi.mock("./storage", () => ({
  saveIdentity: async (i: StoredIdentity) => { identity = structuredClone(i); },
  loadIdentity: async () => (identity ? structuredClone(identity) : null),
  saveDay: async (dayId: string, day: DayFile) => { days[dayId] = structuredClone(day); },
  loadDay: async (dayId: string) => (days[dayId] ? structuredClone(days[dayId]) : null),
  listDays: async () => Object.keys(days).sort().reverse(),
  saveSetting: async (key: string, value: string) => { settings[key] = value; },
  loadSetting: async (key: string) => settings[key] ?? null,
  clearAllLocalData: async () => { identity = null; days = {}; settings = {}; },
}));

vi.mock("./relay", () => ({
  initiatePair: (...args: unknown[]) => mockInitiatePair(...args),
  joinPair: (...args: unknown[]) => mockJoinPair(...args),
}));

vi.mock("./outbox", () => ({
  enqueue: async () => {},
  replaceForDayId: async () => false,
  peekAll: async () => [],
  clearOutbox: async () => {},
}));

vi.mock("./sync", () => ({
  flushOutbox: async () => {},
  requestBackgroundSync: async () => {},
}));

const {
  createIdentity,
  initiateHandshake,
  joinHandshake,
  completeInitiatorPairing,
  unlock,
  isPaired,
} = await import("./store");
const crypto = await import("./crypto");

beforeEach(async () => {
  identity = null;
  days = {};
  settings = {};
  mockInitiatePair.mockReset();
  mockJoinPair.mockReset();
  await crypto.init();
});

describe("re-link handshake state", () => {
  test("initiateHandshake drops the old partner key so writes wait for the new pair", async () => {
    await createIdentity("passphrase");
    const oldPartner = crypto.generateKeyPair();
    identity!.pairId = "old-pair";
    await unlock("passphrase");
    await completeInitiatorPairing(crypto.toBase64(oldPartner.publicKey));
    expect(isPaired()).toBe(true);

    mockInitiatePair.mockResolvedValue({
      status: 201,
      data: { pairId: "new-pair", relayToken: "token-abc" },
    });

    const result = await initiateHandshake();
    expect(result.pairId).toBe("new-pair");
    expect(identity!.pairId).toBe("new-pair");
    expect(identity!.partnerPublicKey).toBeNull();
    expect(isPaired()).toBe(false);
  });

  test("joinHandshake stores the new partner and resets the sync cursor", async () => {
    await createIdentity("passphrase");
    await unlock("passphrase");
    settings["paper-hearts:sync-cursor"] = "2026-09-01T00:00:00.000Z";

    const partner = crypto.generateKeyPair();
    mockJoinPair.mockResolvedValue({
      status: 200,
      data: {
        pairId: "joined-pair",
        partnerPublicKey: crypto.toBase64(partner.publicKey),
      },
    });

    await joinHandshake("relay-token");
    expect(identity!.pairId).toBe("joined-pair");
    expect(identity!.partnerPublicKey).toBe(crypto.toBase64(partner.publicKey));
    expect(isPaired()).toBe(true);
    expect(settings["paper-hearts:sync-cursor"]).toBe("");
  });

  test("completeInitiatorPairing resets the sync cursor", async () => {
    await createIdentity("passphrase");
    await unlock("passphrase");
    settings["paper-hearts:sync-cursor"] = "2026-09-01T00:00:00.000Z";

    const partner = crypto.generateKeyPair();
    await completeInitiatorPairing(crypto.toBase64(partner.publicKey));
    expect(identity!.partnerPublicKey).toBe(crypto.toBase64(partner.publicKey));
    expect(settings["paper-hearts:sync-cursor"]).toBe("");
  });
});
