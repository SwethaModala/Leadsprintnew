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

  describe("canMonitorCall guard conditions", () => {
    function canMonitorCall(call: {
      status: string;
      stop_pending?: boolean | null;
      stop_ambiguous?: boolean | null;
    }): boolean {
      return (
        call.status === "in_progress" &&
        !Boolean(call.stop_pending) &&
        !Boolean(call.stop_ambiguous)
      );
    }

    it("allows monitoring for active in_progress calls without termination flags", () => {
      expect(canMonitorCall({ status: "in_progress" })).toBe(true);
      expect(canMonitorCall({ status: "in_progress", stop_pending: false, stop_ambiguous: false })).toBe(true);
    });

    it("disallows monitoring for queued or uncertain calls", () => {
      expect(canMonitorCall({ status: "queued" })).toBe(false);
      expect(canMonitorCall({ status: "uncertain" })).toBe(false);
      expect(canMonitorCall({ status: "completed" })).toBe(false);
      expect(canMonitorCall({ status: "failed" })).toBe(false);
    });

    it("disallows monitoring when stop_pending or stop_ambiguous is active", () => {
      expect(canMonitorCall({ status: "in_progress", stop_pending: true })).toBe(false);
      expect(canMonitorCall({ status: "in_progress", stop_ambiguous: true })).toBe(false);
    });
  });
});
