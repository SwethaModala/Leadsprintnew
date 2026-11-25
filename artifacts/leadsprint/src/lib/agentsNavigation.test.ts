import { describe, expect, it } from "vitest";

describe("Agents Navigation and Helpers", () => {
  it("defines correct agent status styling and filtering", () => {
    function statusColorClass(status: string) {
      switch (status) {
        case "active":
          return "bg-emerald-50 text-emerald-700 border-emerald-200";
        case "paused":
          return "bg-amber-50 text-amber-700 border-amber-200";
        default:
          return "bg-slate-50 text-slate-700 border-slate-200";
      }
    }

    expect(statusColorClass("active")).toContain("emerald");
    expect(statusColorClass("paused")).toContain("amber");
    expect(statusColorClass("draft")).toContain("slate");

    const sampleAgents = [
      { id: "1", name: "Sara", status: "active", retell_agent_id: "retell_1" },
      { id: "2", name: "Alex", status: "paused", retell_agent_id: null },
      { id: "3", name: "Maya", status: "draft", retell_agent_id: null },
    ];

    const activeOnly = sampleAgents.filter((a) => a.status === "active");
    expect(activeOnly).toHaveLength(1);
    expect(activeOnly[0].name).toBe("Sara");

    const searchSara = sampleAgents.filter((a) =>
      a.name.toLowerCase().includes("sara") ||
      (a.retell_agent_id ?? "").toLowerCase().includes("sara"),
    );
    expect(searchSara).toHaveLength(1);
  });
});
