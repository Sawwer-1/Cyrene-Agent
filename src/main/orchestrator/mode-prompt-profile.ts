import type { ConversationMode } from "../../shared/chat-types";
import { loadPromptFile } from "../prompts/prompt-loader";
import { buildGoldenDescendantsPrompt } from "../tasks/task-character-pool";

export type PromptLoader = (filename: string) => string;

/** v2 槽位重定义后的模式 → 提示词档案表。
 *  chat 沿用四件套；research/legal 用新的三件套 + 精简台词；
 *  work 吸收原 code 的执行人格（提示词扩容在阶段 C）。 */
const MODE_FILES: Record<ConversationMode, readonly string[]> = {
  chat: ["chat_system.md", "chat_identity.md", "soul.md", "canon_quotes.md"],
  research: ["research_system.md", "research_identity.md", "research_method.md", "canon_quotes_lite.md"],
  legal: ["legal_system.md", "legal_identity.md", "legal_discipline.md", "canon_quotes_lite.md"],
  work: ["work_system.md", "work_identity.md", "work_remark.md", "canon_quotes_lite.md"],
};

export function buildModePrompt(mode: ConversationMode, load: PromptLoader = loadPromptFile): string {
  // 黄金裔（子代理协作者池）只给任务型与研究型：research 的多篇文献并行精读适合委派；legal 暂不开。
  const goldenDescendants = mode === "work" || mode === "research"
    ? buildGoldenDescendantsPrompt()
    : "";
  return [...MODE_FILES[mode].map(load), goldenDescendants].filter(Boolean).join("\n\n---\n\n");
}
