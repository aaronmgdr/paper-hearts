import { describe, test, expect } from "vitest";
import { getDayId, formatDayLabel } from "./dayid";

describe("getDayId", () => {
  test("returns today's date after 11 AM", () => {
    const d = new Date("2026-02-23T12:00:00");
    expect(getDayId(d)).toBe("2026-02-23");
  });

  test("returns today's date exactly at 11 AM", () => {
    const d = new Date("2026-02-23T11:00:00");
    expect(getDayId(d)).toBe("2026-02-23");
  });

  test("returns yesterday's date before 11 AM (night owl pivot)", () => {
    const d = new Date("2026-02-23T10:59:59");
    expect(getDayId(d)).toBe("2026-02-22");
  });

  test("handles month boundary correctly (after 11 AM)", () => {
    const d = new Date("2026-03-01T12:00:00");
    expect(getDayId(d)).toBe("2026-03-01");
  });

  test("handles month boundary correctly (before 11 AM rolls back to last day of previous month)", () => {
    const d = new Date("2026-03-01T01:00:00");
    expect(getDayId(d)).toBe("2026-02-28");
  });
});

describe("formatDayLabel", () => {
  test("formats a dayId to readable label", () => {
    const label = formatDayLabel("2026-02-23");
    expect(label).toMatch(/Monday/);
    expect(label).toMatch(/Feb/);
    expect(label).toMatch(/23/);
  });

  test("includes weekday, month, and day", () => {
    const label = formatDayLabel("2026-01-01");
    expect(label).toMatch(/Thursday/);
    expect(label).toMatch(/Jan/);
    expect(label).toMatch(/1/);
  });
});
