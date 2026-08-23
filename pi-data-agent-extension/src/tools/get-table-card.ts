/**
 * v0.10 A-4 — get_table_card 工具（L1 按需取用层）
 *
 * 自身不存知识，只做三源读取与拼装（规范 §6.2 装配规则）：
 * 1.【表卡片】← table-cards.json；无卡片时用 schema 生成骨架并注明"待补充"
 * 2.【相关指标口径】← metrics.json，过滤 metric.datasets 包含该表；命中 ≤5 条取 名称+计算规则；0 条省略该节
 * 3.【字段业务含义】← 合并字典视图（session > project > global），该表全部列按可信度排序
 *    （已修正 > 已确认 > AI推测[未确认] > 不确定[不可靠]），只取前 20 个字段
 *
 * 返回体 300~500 token 属正常（模型主动索取，不设硬限）。
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ToolRegisterParams } from "./tool-context.js";
import type { ColumnSemanticStatus } from "../types.js";
import { createSkeletonCard, computeTableSchemaFingerprint } from "../table-cards/store.js";
import { listActiveMetricDefinitions } from "../metrics/metric-definitions.js";

/** 单表关联指标上限 */
const RELATED_METRIC_LIMIT = 5;

/** 字段含义条数上限（规范 §6.2：前 15~20 个字段） */
const FIELD_MEANING_LIMIT = 20;

const STATUS_LABEL: Record<ColumnSemanticStatus, string> = {
  "user-corrected": "已修正",
  "user-confirmed": "已确认",
  "ai-guessed": "AI推测",
  uncertain: "不确定",
};

/** 可信度排序权重（小者在前） */
const STATUS_WEIGHT: Record<ColumnSemanticStatus, number> = {
  "user-corrected": 0,
  "user-confirmed": 1,
  "ai-guessed": 2,
  uncertain: 3,
};

const STATUS_WARNING: Partial<Record<ColumnSemanticStatus, string>> = {
  "ai-guessed": "(未确认)",
  uncertain: "(不可靠)",
};

const GetTableCardParams = Type.Object({
  table_name: Type.String({ description: "要查看的表名（见 Data Navigation 导航列表）" }),
});

export function createGetTableCardTool(params: ToolRegisterParams): ToolDefinition {
  return {
    name: "get_table_card",
    label: "Get Table Card",
    description:
      "Get the semantic knowledge card for one table: what the table is for, suitable analyses, " +
      "boundaries, when to use it, related metric definitions (must-follow calculation rules), " +
      "and business meanings of fields sorted by reliability. " +
      "Call this BEFORE writing SQL whenever you are unsure about a table's purpose or boundaries.",
    parameters: GetTableCardParams,
    execute: async (
      _toolCallId: string,
      args: { table_name: string },
      _signal: AbortSignal | undefined,
      _onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
      _ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      const rt = params.getRuntime();
      if (!rt?.engine) {
        return {
          content: [{ type: "text", text: "Error: DuckDB engine not available." }],
          details: { toolName: "get_table_card", error: "engine not available" },
        };
      }

      const tableName = args.table_name.trim();

      // 表必须存在（不存在时返回可用错误 + 当前可用表清单）
      let tables: string[];
      try {
        tables = await rt.engine.getTables();
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing tables: ${err}` }],
          details: { toolName: "get_table_card", error: String(err) },
        };
      }
      if (!tables.includes(tableName)) {
        return {
          content: [{
            type: "text",
            text: `Table "${tableName}" not found. Available tables:\n${tables.map((t) => `- ${t}`).join("\n") || "(none)"}`,
          }],
          details: { toolName: "get_table_card", error: "table_not_found", availableTables: tables },
        };
      }

      // ===== 源 1：【表卡片】 =====
      const columns = await rt.engine.getSchema(tableName);
      const fingerprint = computeTableSchemaFingerprint(tableName, columns);
      const store = rt.tableCards;
      const existingCard = store?.get(tableName) ?? null;
      const card = existingCard ?? createSkeletonCard(tableName, fingerprint);

      const cardLines: string[] = ["【表卡片】", `表名: ${card.tableName}`];
      const isSkeleton = !existingCard;
      if (isSkeleton) {
        cardLines.push("概述: （待补充——尚无表卡片，以下为 schema 骨架）");
      } else {
        cardLines.push(`概述: ${card.summary || "（待补充）"}`);
      }
      const listBlock = (title: string, items: string[]) => {
        cardLines.push(`${title}:`);
        cardLines.push(items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "- （待补充）");
      };
      listBlock("适合场景", card.suitableFor);
      listBlock("边界与坑", card.boundaries);
      listBlock("何时使用", card.whenToUse);
      cardLines.push(`标签: ${card.tags.length > 0 ? card.tags.join("、") : "（无）"}`);
      const statusText = card.stale
        ? "已过期（表结构已变化，卡片内容可能过期，建议在 Dashboard 重新起草）"
        : card.status === "user-confirmed"
          ? "已确认"
          : isSkeleton
            ? "骨架（待补充）"
            : "AI 起草（未经用户确认）";
      cardLines.push(`状态: ${statusText}`);

      // ===== 源 2：【相关指标口径】（datasets 关联，≤5 条，0 条省略该节） =====
      const relatedMetrics = listActiveMetricDefinitions(rt.config.projectConfigDir)
        .filter((m) => Array.isArray(m.datasets) && m.datasets.includes(tableName))
        .slice(0, RELATED_METRIC_LIMIT);

      // ===== 源 3：【字段业务含义】（合并字典，按可信度排序，前 20 个字段） =====
      const dictEntry = rt.persistence.loadMergedDataDictionary().get(tableName);
      const sortedColumns = dictEntry
        ? [...dictEntry.columns].sort(
            (a, b) => (STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status])
          )
        : [];
      const shownColumns = sortedColumns.slice(0, FIELD_MEANING_LIMIT);

      // ===== 固定模板拼装 =====
      const parts: string[] = [cardLines.join("\n")];

      if (relatedMetrics.length > 0) {
        const metricLines = relatedMetrics.map((m) => `- ${m.name}: ${m.definition.replace(/\n+/g, " ")}`);
        parts.push(
          "【相关指标口径】（SQL 涉及下列指标时必须遵守其计算规则）\n" +
          metricLines.join("\n")
        );
      }

      if (dictEntry && shownColumns.length > 0) {
        const fieldLines = shownColumns.map((col) => {
          const meaning = col.userMeaning ?? col.inferredMeaning ?? "—";
          const warning = STATUS_WARNING[col.status] ?? "";
          const aliases = col.aliases && col.aliases.length > 0 ? ` / 别名: ${col.aliases.join(", ")}` : "";
          return `- [${STATUS_LABEL[col.status]}] ${col.name} (${col.type}): ${meaning}${warning}${aliases}`;
        });
        const hiddenCount = sortedColumns.length - shownColumns.length;
        parts.push(
          "【字段业务含义】（按可信度排序：已修正 > 已确认 > AI推测 > 不确定）\n" +
          fieldLines.join("\n") +
          (hiddenCount > 0 ? `\n（其余 ${hiddenCount} 个字段未列出，可用 describe_data 查看）` : "")
        );
      } else {
        parts.push(
          "【字段业务含义】\n（暂无该表的字段字典。可在 Dashboard「语义」Tab 对该表运行 AI 推断补全字段含义，或用 describe_data 查看结构。）"
        );
      }

      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
        details: {
          toolName: "get_table_card",
          tableName,
          cardSource: existingCard ? "stored" : "skeleton",
          stale: card.stale,
          relatedMetrics: relatedMetrics.map((m) => ({ id: m.id, name: m.name })),
          fieldMeaningCount: shownColumns.length,
        },
      };
    },
  };
}
