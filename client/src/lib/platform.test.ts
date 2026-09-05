import { afterEach, describe, expect, test, vi } from "vitest";
import { isIOS, isStandalonePWA } from "./platform";

const originalUA = navigator.userAgent;
const originalPlatform = navigator.platform;
const originalMaxTouch = navigator.maxTouchPoints;
const originalStandalone = (navigator as Navigator & { standalone?: boolean }).standalone;

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: originalUA });
  Object.defineProperty(navigator, "platform", { configurable: true, value: originalPlatform });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: originalMaxTouch });
  Object.defineProperty(navigator, "standalone", { configurable: true, value: originalStandalone });
});

describe("isIOS", () => {
  test("detects iPhone", () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    });
    expect(isIOS()).toBe(true);
  });

  test("is false on Android", () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0",
    });
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Linux armv8l" });
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
    expect(isIOS()).toBe(false);
  });
});

describe("isStandalonePWA", () => {
  test("is true when Safari reports navigator.standalone", () => {
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    expect(isStandalonePWA()).toBe(true);
  });

  test("is true for display-mode: standalone", () => {
    Object.defineProperty(navigator, "standalone", { configurable: true, value: false });
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes("standalone"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as MediaQueryList) as typeof window.matchMedia;
    expect(isStandalonePWA()).toBe(true);
  });
});
