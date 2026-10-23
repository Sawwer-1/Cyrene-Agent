import { describe, expect, it } from "vitest";
import { buildModePrompt } from "./mode-prompt-profile";

const marker = (name: string) => `[${name}]`;
const load = (name: string) => marker(name);

describe("buildModePrompt", () => {
  it.each([
    ["chat", ["chat_system.md", "chat_identity.md", "soul.md", "canon_quotes.md"], ["cyrene_harness.md", "work_system.md", "research_system.md", "legal_system.md"]],
    ["work", ["work_system.md", "work_identity.md", "work_remark.md", "canon_quotes_lite.md"], ["soul.md", "chat_system.md", "research_system.md", "legal_system.md"]],
    ["research", ["research_system.md", "research_identity.md", "research_method.md", "canon_quotes_lite.md"], ["soul.md", "chat_system.md", "work_system.md", "legal_system.md"]],
    ["legal", ["legal_system.md", "legal_identity.md", "legal_discipline.md", "canon_quotes_lite.md"], ["soul.md", "chat_system.md", "work_system.md", "research_system.md"]],
  ] as const)("isolates %s prompt files", (mode, included, excluded) => {
    const prompt = buildModePrompt(mode, load);
    for (const file of included) expect(prompt).toContain(marker(file));
    for (const file of excluded) expect(prompt).not.toContain(marker(file));
  });

  it("only injects the Golden Descendant roster into task-capable modes", () => {
    expect(buildModePrompt("work", load)).toContain("可委托的黄金裔");
    expect(buildModePrompt("research", load)).toContain("可委托的黄金裔");
    expect(buildModePrompt("chat", load)).not.toContain("可委托的黄金裔");
    expect(buildModePrompt("legal", load)).not.toContain("可委托的黄金裔");
  });
});
