import { describe, expect, it } from "vitest";

import { managerMayAlterAiMessage } from "./ai-message-correction.berseba";

describe("managerMayAlterAiMessage", () => {
  it("lets a manager or admin alter an AI message", () => {
    expect(managerMayAlterAiMessage("ai", "manager")).toBe(true);
    expect(managerMayAlterAiMessage("ai", "admin")).toBe(true);
  });

  it("refuses an agent, a viewer and an unknown role", () => {
    expect(managerMayAlterAiMessage("ai", "agent")).toBe(false);
    expect(managerMayAlterAiMessage("ai", "viewer")).toBe(false);
    expect(managerMayAlterAiMessage("ai", null)).toBe(false);
    expect(managerMayAlterAiMessage("ai", "owner")).toBe(false);
  });

  it("only covers the AI agent: other origins stay out, even for an admin", () => {
    for (const sentVia of ["user", "crm", "automation", "system", "external_device", null, undefined]) {
      expect(managerMayAlterAiMessage(sentVia, "admin")).toBe(false);
    }
  });
});
