import { describe, expect, test } from "vitest";
import { parseDeviceLinkToken } from "./devicelink";

const TOKEN = "abcdefghijklmnopqrstuv-0123456789ABCDEF";

describe("parseDeviceLinkToken", () => {
  test("accepts a raw mailbox token", () => {
    expect(parseDeviceLinkToken(TOKEN)).toBe(TOKEN);
  });

  test("accepts a full device-link URL", () => {
    expect(parseDeviceLinkToken(`https://paperhearts.example/device-link?token=${TOKEN}`)).toBe(TOKEN);
  });

  test("accepts a path with a query string", () => {
    expect(parseDeviceLinkToken(`/device-link?token=${TOKEN}`)).toBe(TOKEN);
  });

  test("decodes a percent-encoded token", () => {
    expect(parseDeviceLinkToken(`https://x.test/device-link?token=${encodeURIComponent(TOKEN)}`)).toBe(TOKEN);
  });

  test("trims whitespace", () => {
    expect(parseDeviceLinkToken(`  ${TOKEN}  `)).toBe(TOKEN);
  });

  test("rejects empty and garbage", () => {
    expect(parseDeviceLinkToken("")).toBeUndefined();
    expect(parseDeviceLinkToken("   ")).toBeUndefined();
    expect(parseDeviceLinkToken("not a link")).toBeUndefined();
    expect(parseDeviceLinkToken("short")).toBeUndefined();
  });
});
