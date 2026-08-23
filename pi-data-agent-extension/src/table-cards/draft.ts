/**
 * v0.10 A-3 — 表卡片 AI 起草
 *
 * 输入 = schema + 5 行样本 + 该表近期查询记忆（按 fingerprint/SQL 引用召回，无则空），
 * 调 LLM 输出结构化 JSON；解析失败重试一次；仍失败或无 LLM → schema 推导的骨架卡。
 *
 * ensureTableCard：load_data / 上传成功后的 fire-and-forget 路径——
 * 已有同 fingerprint 卡片跳过；fingerprint 不匹配标记 stale（不覆盖用户内容）；
 * 无卡片才起草。draftCardForTable：Dashboard "AI 起草" 按钮的强制重绘路径。
 */

import type { DuckDBEngine } from "../engine/duckdb.js";
import type { QueryMemoryEntry, ColumnInfo } from "../types.js";
import {
  TableCardStore,
  createSkeletonCard,
  computeTableSchemaFingerprint,
} from "./store.js";
import type { TableCard } from "./store.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("table-cards");

/** 起草用样本行数 */
const SAMPLE_ROWS = 5;

/** 召回给 LLM 的近期查询条数上限 */
const RECENT_QUERY_LIMIT = 3;

type CallLLMFn = (prompt: string, systemPrompt?: string) => Promise<string>;

/** 构造起草 prompt（schema + 样本 + 近期查询） */
export function buildDraftPrompt(params: {
  tableName: string;
  columns: ColumnInfo[];
  samples: unknown[][];
  recentQueries: Array<Pick<QueryMemoryEntry, "naturalLanguageQuery" | "sql">>;
}): string {
  const { tableName, columns, samples, recentQueries } = params;
  const colLines = columns.map((c) => `- ${c.name} (${c.type})`).join("\n");
  const sampleLines = samples
    .slice(0, SAMPLE_ROWS)
    .map((row) => JSON.stringify(row))
    .join("\n");
  const queryLines = recentQueries.length
    ? recentQueries.map((q) => `- 问: ${q.naturalLanguageQuery}\n  SQL: ${q.sql}`).join("\n")
    : "（无）";

  return [
    `请为数据表 "${tableName}" 生成一张"表卡片"，帮助分析助手理解这张表的用途与边界。`,
    "",
    "## 表结构",
    colLines,
    "",
    "## 样本数据（最多 5 行）",
    sampleLines || "（空表）",
    "",
    "## 用户近期对该表的查询",
    queryLines,
    "",
    "请只输出一个 JSON 对象（不要 markdown 代码块、不要解释），字段如下：",
    `{`,
    `  "summary": "一句话说明这是什么表（中文，≤40 字）",`,
    `  "suitableFor": ["适合用它回答的分析场景/问题类型", "..."],`,
    `  "boundaries": ["不含什么/时间范围/已知坑", "..."],`,
    `  "whenToUse": ["什么问题应该来找这张表（触发词/场景）", "..."],`,
    `  "tags": ["1-3 个分类标签，如 订单/用户/财务"]`,
    `}`,
  ].join("\n");
}

const DRAFT_SYSTEM_PROMPT =
  "你是数据仓库文档专家。根据表结构与样本输出严格合法的 JSON 对象，禁止输出任何 JSON 以外的内容。";

/** 从 LLM 文本中提取 JSON 对象（容忍 markdown 代码块包裹） */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(trimmed);
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

/** 清洗字符串数组字段 */
function toStringArray(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return list.map((v) => String(v ?? "").trim()).filter((v) => v.length > 0);
}

/** 将 LLM 输出转换为 TableCard（字段缺失时退化为骨架默认值） */
function cardFromLLMOutput(
  tableName: string,
  fingerprint: string,
  output: Record<string, unknown>,
): TableCard {
  const summary = typeof output.summary === "string" ? output.summary.trim() : "";
  if (!summary) {
    // 没有 summary 视为无效输出，走骨架
    return createSkeletonCard(tableName, fingerprint);
  }
  return {
    tableName,
    summary,
    suitableFor: toStringArray(output.suitableFor),
    boundaries: toStringArray(output.boundaries),
    whenToUse: toStringArray(output.whenToUse),
    tags: toStringArray(output.tags),
    status: "ai-drafted",
    fingerprint,
    stale: false,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 单次调用 + 解析失败重试一次的结构化起草。
 * 两次都失败抛错（调用方决定是否降级骨架）。
 */
export async function draftCardWithLLM(
  promptInput: Parameters<typeof buildDraftPrompt>[0],
  fingerprint: string,
  callLLM: CallLLMFn,
): Promise<TableCard> {
  const prompt = buildDraftPrompt(promptInput);
  let lastOutput: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callLLM(prompt, DRAFT_SYSTEM_PROMPT);
    const parsed = extractJsonObject(raw);
    if (!parsed) continue; // 解析失败 → 重试一次
    lastOutput = parsed;
    break;
  }
  if (!lastOutput) {
    throw new Error("表卡片起草失败：LLM 输出无法解析为 JSON（已重试一次）");
  }
  return cardFromLLMOutput(promptInput.tableName, fingerprint, lastOutput);
}

/** 从查询记忆中召回该表近期查询（SQL 引用该表，或指纹匹配），最多 3 条、新者优先 */
export function recallRecentQueriesForTable(
  entries: QueryMemoryEntry[],
  tableName: string,
  fingerprint: string,
): Array<Pick<QueryMemoryEntry, "naturalLanguageQuery" | "sql">> {
  const lowerName = tableName.toLowerCase();
  const matched = entries.filter((e) => {
    if (e.success === false) return false;
    if (e.datasetFingerprint && e.datasetFingerprint === fingerprint) return true;
    return e.sql.toLowerCase().includes(lowerName);
  });
  matched.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return matched.slice(0, RECENT_QUERY_LIMIT).map((e) => ({
    naturalLanguageQuery: e.naturalLanguageQuery,
    sql: e.sql,
  }));
}

/** ensureTableCard / draftCardForTable 的公共依赖 */
export interface CardDraftDeps {
  store: TableCardStore;
  engine: DuckDBEngine;
  /** LLM 缺失时 ensureTableCard 生成骨架卡；draftCardForTable 由路由先做 503 校验 */
  callLLM?: CallLLMFn;
  /** 该表近期查询记忆（调用方从 QueryMemoryManager / query-memory.json 提供） */
  recentQueries?: QueryMemoryEntry[];
}

/**
 * 计算表的当前 schema 指纹（表不存在时返回 ""）
 */
export async function computeTableFingerprint(engine: DuckDBEngine, tableName: string): Promise<string> {
  try {
    const columns = await engine.getSchema(tableName);
    return computeTableSchemaFingerprint(tableName, columns);
  } catch {
    return "";
  }
}

/**
 * fire-and-forget 起草路径（load_data / 上传成功后调用）：
 *
 * - 表无卡片 → AI 起草（无 LLM 时骨架卡）
 * - 卡片 fingerprint 与当前一致 → 跳过（返回 drafted=false）
 * - fingerprint 不匹配 → 仅标记 stale，不覆盖内容（保护 user-confirmed 卡片，提示重新起草）
 * - 任何失败静默（logger.debug），绝不阻塞加载主流程
 */
export async function ensureTableCard(
  deps: CardDraftDeps,
  tableName: string,
): Promise<{ card: TableCard; drafted: boolean } | null> {
  const { store, engine } = deps;
  try {
    const fingerprint = await computeTableFingerprint(engine, tableName);
    if (!fingerprint) return null;

    const existing = store.get(tableName);
    if (existing) {
      if (existing.fingerprint === fingerprint) {
        return { card: existing, drafted: false }; // 同结构，跳过
      }
      // 结构变化 → 标 stale，等待用户重新起草/确认
      store.markStaleIfChanged(tableName, fingerprint);
      return { card: store.get(tableName) ?? existing, drafted: false };
    }

    // 无卡片 → 起草（AI 或骨架）
    const card = await draftCardForTable(deps, tableName, fingerprint);
    store.saveDraft(card);
    logger.debug(`Table card drafted for ${tableName} (${deps.callLLM ? "ai" : "skeleton"})`);
    return { card, drafted: true };
  } catch (err) {
    logger.debug(`ensureTableCard failed for ${tableName}:`, err);
    return null;
  }
}

/**
 * 强制（重新）起草：Dashboard "AI 起草" 按钮路径。
 * 有 LLM 用 AI；无 LLM 返回骨架卡（路由层通常提前 503，此处兜底骨架不抛错）。
 */
export async function draftCardForTable(
  deps: CardDraftDeps,
  tableName: string,
  fingerprintOverride?: string,
): Promise<TableCard> {
  const { engine } = deps;
  const columns = await engine.getSchema(tableName);
  const fingerprint = fingerprintOverride || computeTableSchemaFingerprint(tableName, columns);
  const samples = await engine.getSample(tableName, SAMPLE_ROWS).catch(() => [] as unknown[][]);
  const recentQueries = recallRecentQueriesForTable(deps.recentQueries ?? [], tableName, fingerprint);

  if (!deps.callLLM) {
    return createSkeletonCard(tableName, fingerprint);
  }

  try {
    return await draftCardWithLLM({ tableName, columns, samples, recentQueries }, fingerprint, deps.callLLM);
  } catch (err) {
    logger.debug(`AI draft failed for ${tableName}, falling back to skeleton:`, err);
    return createSkeletonCard(tableName, fingerprint);
  }
}
