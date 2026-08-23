/**
 * S3.1 ask-clarification — 主动反问工具
 *
 * 交互工具，不计入 9 个数据工具。
 * 展示结构化选项让用户选择，每个选项自带 impliedAssumption（摊口径）。
 *
 * 契约：
 * - 2-4 个选项，每个带 impliedAssumption
 * - defaultIfSkip: 用户说"你定"时自动选默认
 * - allowFreeText: 是否允许自由文本输入
 * - 非交互模式（无 ctx.ui）→ 走 defaultIfSkip
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Clarification, ClarificationAnswer, CaliberEntry } from "../types.js";
import type { ToolRegisterParams, ToolContext } from "./tool-context.js";
import { createHash } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("ask-clarification");

const AskClarificationParams = Type.Object({
  question: Type.String({ description: "反问问题" }),
  why: Type.String({ description: "为什么需要反问（上下文说明）" }),
  options: Type.Array(Type.Object({
    id: Type.String({ description: "选项 ID" }),
    label: Type.String({ description: "展示标签" }),
    implied_assumption: Type.String({ description: "此选项隐含的口径假设" }),
  }), { minItems: 2, maxItems: 4, description: "结构化选项（2-4 个）" }),
  allow_free_text: Type.Optional(Type.Boolean({ description: "是否允许自由文本输入", default: false })),
  default_if_skip: Type.String({ description: "用户跳过时的默认选项 ID" }),
});

/** 基于 question 生成口径 ID（稳定 hash） */
function caliberId(question: string): string {
  return createHash("sha256").update(question).digest("hex").slice(0, 12);
}

/** 将确认的口径写入 agent.md（写入失败只 warning，不阻塞） */
function writeCaliberToAgentMd(
  ctx: ToolContext,
  question: string,
  selectedOption: { label: string; impliedAssumption: string }
): void {
  try {
    const entry: CaliberEntry = {
      id: caliberId(question),
      question,
      definition: selectedOption.label,
      appliedAssumption: selectedOption.impliedAssumption,
      confirmedAt: new Date().toISOString(),
      status: "confirmed",
    };
    ctx.persistence.saveCaliber(entry);
    logger.debug(`Caliber saved: "${question}" → "${selectedOption.label}"`);
  } catch (err) {
    logger.warn("Failed to save caliber to agent.md:", err);
  }
}

export function createAskClarificationTool(params: ToolRegisterParams): ToolDefinition {
  return {
    name: "ask_clarification",
    label: "Ask Clarification",
    description:
      "Ask the user a clarifying question with structured options. " +
      "Each option has an implied assumption. " +
      "If the user skips, the default option is used automatically. " +
      "This tool does NOT execute data operations — it only resolves ambiguity.",
    parameters: AskClarificationParams,
    execute: async (
      toolCallId: string,
      args: {
        question: string;
        why: string;
        options: Array<{ id: string; label: string; implied_assumption: string }>;
        allow_free_text?: boolean;
        default_if_skip: string;
      },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      // 构建标准化 Clarification 结构
      const clarification: Clarification = {
        question: args.question,
        why: args.why,
        options: args.options.map((o) => ({
          id: o.id,
          label: o.label,
          impliedAssumption: o.implied_assumption,
        })),
        allowFreeText: args.allow_free_text ?? false,
        defaultIfSkip: args.default_if_skip,
      };

      // 验证 defaultIfSkip 在选项中
      const defaultOption = clarification.options.find((o) => o.id === clarification.defaultIfSkip);
      if (!defaultOption) {
        return {
          content: [{ type: "text", text: `Error: default_if_skip "${clarification.defaultIfSkip}" not found in options.` }],
          details: { toolName: "ask_clarification", error: "invalid_default" },
        };
      }

      // 非交互模式：自动使用默认值
      if (!ctx.ui) {
        const answer: ClarificationAnswer = {
          value: defaultOption.id,
          isDefault: true,
          appliedAssumption: defaultOption.impliedAssumption,
        };
        // 写入口径到 agent.md
        const rt = params.getRuntime();
        if (rt) {
          writeCaliberToAgentMd(rt, args.question, defaultOption);
        }
        return {
          content: [{
            type: "text",
            text: `[Non-interactive mode] Auto-selected: "${defaultOption.label}" (${defaultOption.impliedAssumption})`,
          }],
          details: {
            toolName: "ask_clarification",
            clarification,
            answer,
            mode: "non-interactive",
          },
        };
      }

      // 交互模式：展示选项
      try {
        // 构建选择列表：label (impliedAssumption)
        const choices = clarification.options.map((o) => ({
          id: o.id,
          label: `${o.label} — ${o.impliedAssumption}`,
        }));

        // 使用 ctx.ui.select 展示选项
        const selectedId = await ctx.ui.select(
          clarification.question,
          choices.map((c) => c.label),
          { timeout: 120000 }
        );

        // 用户取消了选择
        if (!selectedId) {
          // 使用默认值
          const answer: ClarificationAnswer = {
            value: defaultOption.id,
            isDefault: true,
            appliedAssumption: defaultOption.impliedAssumption,
          };
          return {
            content: [{
              type: "text",
              text: `User skipped. Auto-selected default: "${defaultOption.label}" (${defaultOption.impliedAssumption})`,
            }],
            details: {
              toolName: "ask_clarification",
              clarification,
              answer,
              mode: "default",
            },
          };
        }

        // 找到选中的选项
        const selectedOption = clarification.options.find((o) =>
          `${o.label} — ${o.impliedAssumption}` === selectedId
        );

        if (!selectedOption) {
          // 如果匹配失败，回退到默认值
          const answer: ClarificationAnswer = {
            value: defaultOption.id,
            isDefault: true,
            appliedAssumption: defaultOption.impliedAssumption,
          };
          return {
            content: [{
              type: "text",
              text: `Selection not recognized. Auto-selected default: "${defaultOption.label}"`,
            }],
            details: {
              toolName: "ask_clarification",
              clarification,
              answer,
              mode: "fallback",
            },
          };
        }

        const answer: ClarificationAnswer = {
          value: selectedOption.id,
          isDefault: false,
          appliedAssumption: selectedOption.impliedAssumption,
        };

        // 写入口径到 agent.md
        const rt = params.getRuntime();
        if (rt) {
          writeCaliberToAgentMd(rt, args.question, selectedOption);
        }

        return {
          content: [{
            type: "text",
            text: `Selected: "${selectedOption.label}" (${selectedOption.impliedAssumption})`,
          }],
          details: {
            toolName: "ask_clarification",
            clarification,
            answer,
            mode: "interactive",
          },
        };
      } catch (err) {
        // 出错时回退到默认值
        const answer: ClarificationAnswer = {
          value: defaultOption.id,
          isDefault: true,
          appliedAssumption: defaultOption.impliedAssumption,
        };
        return {
          content: [{
            type: "text",
            text: `Error during clarification: ${err}. Auto-selected default: "${defaultOption.label}"`,
          }],
          details: {
            toolName: "ask_clarification",
            clarification,
            answer,
            mode: "error-fallback",
            error: String(err),
          },
        };
      }
    },
  };
}
