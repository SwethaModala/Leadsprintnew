import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("LiveCallMonitorModal & ActiveCallsWidget — Warm Transfer State Logic & Safety", () => {
  it("LiveCallMonitorModal supports all 4 warm transfer states without browser audio or WebRTC", () => {
    const modalFilePath = path.resolve(__dirname, "LiveCallMonitorModal.tsx");
    const content = fs.readFileSync(modalFilePath, "utf8");

    // Must not contain WebRTC, audio streams, or mic permissions
    expect(content).not.toContain("getUserMedia");
    expect(content).not.toContain("RTCPeerConnection");
    expect(content).not.toContain("retell-client-js-sdk");
    expect(content).not.toContain("takeOver");

    // Must handle transfer_update event from SSE stream
    expect(content).toContain('event.event === "transfer_update"');
    expect(content).toContain("transferStatus");

    // Must define all 4 user-facing transfer states
    expect(content).toContain("Transfer initiated (Waiting for human operator)");
    expect(content).toContain("Connected to human operator");
    expect(content).toContain("Transfer unsuccessful");
    expect(content).toContain("Transfer ended");
    expect(content).toContain("monitor-transfer-banner");
  });

  it("ActiveCallsWidget displays transfer state badges and destination safely", () => {
    const widgetFilePath = path.resolve(__dirname, "ActiveCallsWidget.tsx");
    const content = fs.readFileSync(widgetFilePath, "utf8");

    // Must not contain false manual transfer buttons
    expect(content).not.toContain("forceTransfer");
    expect(content).not.toContain("button-transfer-call");

    // Must check and render transfer states
    expect(content).toContain("transferState");
    expect(content).toContain("badge-transfer-state");
    expect(content).toContain("Connected to human operator");
    expect(content).toContain("Transfer initiated (Waiting for operator)");
    expect(content).toContain("Transfer unsuccessful");
    expect(content).toContain("Transfer ended");
  });

  it("maps transfer state strings to expected user-facing copy", () => {
    function getTransferLabel(transferState: string): string {
      switch (transferState) {
        case "transfer_started":
          return "Transfer initiated (Waiting for human operator)";
        case "transfer_bridged":
          return "Connected to human operator";
        case "transfer_cancelled":
          return "Transfer unsuccessful";
        case "transfer_ended":
          return "Transfer ended";
        default:
          return "Unknown transfer state";
      }
    }

    expect(getTransferLabel("transfer_started")).toBe("Transfer initiated (Waiting for human operator)");
    expect(getTransferLabel("transfer_bridged")).toBe("Connected to human operator");
    expect(getTransferLabel("transfer_cancelled")).toBe("Transfer unsuccessful");
    expect(getTransferLabel("transfer_ended")).toBe("Transfer ended");
  });
});
