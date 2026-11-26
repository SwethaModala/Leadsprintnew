import { describe, expect, it } from "vitest";
import { formatElapsed, parseElapsedSeconds } from "./ActiveCallsWidget";

describe("ActiveCallsWidget helper functions", () => {
  describe("formatElapsed", () => {
    it("formats 0 seconds as 00:00", () => {
      expect(formatElapsed(0)).toBe("00:00");
    });

    it("formats sub-minute seconds correctly", () => {
      expect(formatElapsed(5)).toBe("00:05");
      expect(formatElapsed(45)).toBe("00:45");
    });

    it("formats multi-minute durations correctly", () => {
      expect(formatElapsed(60)).toBe("01:00");
      expect(formatElapsed(125)).toBe("02:05");
      expect(formatElapsed(3600)).toBe("60:00");
    });

    it("safely handles NaN and negative values without displaying invalid text", () => {
      expect(formatElapsed(NaN)).toBe("00:00");
      expect(formatElapsed(-10)).toBe("00:00");
    });
  });

  describe("parseElapsedSeconds", () => {
    it("returns null for null, undefined, or empty startedAt", () => {
      expect(parseElapsedSeconds(null)).toBeNull();
      expect(parseElapsedSeconds(undefined)).toBeNull();
      expect(parseElapsedSeconds("")).toBeNull();
    });

    it("returns null for invalid or malformed dates (NaN guard)", () => {
      expect(parseElapsedSeconds("invalid-date-string")).toBeNull();
      expect(parseElapsedSeconds("undefined")).toBeNull();
      expect(parseElapsedSeconds("null")).toBeNull();
    });

    it("returns positive elapsed seconds for valid past timestamp", () => {
      const past = new Date(Date.now() - 30_000).toISOString();
      const elapsed = parseElapsedSeconds(past);
      expect(elapsed).toBeGreaterThanOrEqual(29);
      expect(elapsed).toBeLessThanOrEqual(32);
    });
  });
});
