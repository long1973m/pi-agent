/**
 * S3.4 query-memory — 查询记忆
 *
 * MVP 范围：容量闸 + 相关性闸（过时闸推 v0.2）
 *
 * 容量闸：频次 × 新近 × 相关性加权淘汰，保留最多 5 条
 * 相关性闸：数据集指纹匹配，只召回涉及当前数据集的查询
 * 注入：before_agent_start 时，最多注入 3 条相关查询到 system prompt（v0.10 A-4 加预算上限）
 * 入库：只存成功查询；相同 SQL → useCount++；新 SQL → 新建 entry
 * 持久化：通过 PersistenceManager
 * v0.10 A-5：pinned 手动固定——不参与容量淘汰，经 getPinnedEntries 注入 L0 导航层
 */

import type { QueryMemory, QueryMemoryEntry, PersistableData, FailureCategory, FailedQueryEntry } from "../types.js";
import type { PersistenceManager } from "../persistence.js";
import { normalizeSql } from "../utils/sql-normalizer.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("query-memory");

/** 错误分类关键词规则 */
const FAILURE_PATTERNS: Array<{ category: FailureCategory; patterns: RegExp[] }> = [
  {
    category: "syntax_error",
    patterns: [
      /syntax error/i,
      /parser error/i,
      /invalid sql/i,
      /unexpected token/i,
      /mismatched/i,
      /invalid input/i,
      /malformed/i,
    ],
  },
  {
    category: "not_found",
    patterns: [
      /table.*not (?:found|exist)/i,
      /relation.*does not exist/i,
      /column.*not (?:found|exist)/i,
      /could not find/i,
      /no such (?:table|column|field)/i,
      /does not exist/i,
    ],
  },
  {
    category: "permission",
    patterns: [
      /permission denied/i,
      /access denied/i,
      /not authorized/i,
      /read-only/i,
      /security blocked/i,
    ],
  },
  {
    category: "timeout",
    patterns: [
      /timeout/i,
      /timed out/i,
      /deadline exceeded/i,
    ],
  },
];

/** 基于错误消息分类失败类型 */
export function classifyError(errorMessage: string): FailureCategory {
  const msg = errorMessage.toLowerCase();
  for (const { category, patterns } of FAILURE_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(msg)) return category;
    }
  }
  return "unknown";
}

/** 查询记忆管理器 */
export class QueryMemoryManager {
  private memory: QueryMemory;
  private persistence: PersistenceManager;
  private currentDatasetFingerprint: string | null = null;
  /** 失败查询（独立存储，不参与成功查询容量闸） */
  private failedQueries: FailedQueryEntry[] = [];
  /** 失败查询最大保留条数 */
  private static readonly MAX_FAILED_ENTRIES = 10;

  constructor(persistence: PersistenceManager, maxEntries?: number) {
    this.persistence = persistence;
    // 尝试从持久化加载
    const loaded = persistence.loadQueryMemory("project");
    this.memory = loaded ?? { maxEntries: 5, entries: [] };
    // F-1（v0.11）：maxQueryMemoryEntries 配置实际生效——显式传入时覆盖持久化值/默认值
    if (maxEntries !== undefined && Number.isFinite(maxEntries) && maxEntries > 0) {
      this.memory.maxEntries = maxEntries;
    }
    // 加载失败查询
    this.loadFailedQueries();
  }

  /** 设置当前数据集指纹（用于相关性匹配） */
  setDatasetFingerprint(fingerprint: string | null): void {
    this.currentDatasetFingerprint = fingerprint;
  }

  /** 获取当前数据集指纹 */
  getCurrentDatasetFingerprint(): string | null {
    return this.currentDatasetFingerprint;
  }

  // ==========================================================================
  // 入库
  // ==========================================================================

  /**
   * 记录一次成功查询
   *
   * 规则：
   * - 相同 SQL → useCount++，更新 timestamp
   * - 新 SQL → 新建 entry
   * - 超过容量 → 淘汰最低分
   */
  recordQuery(params: {
    naturalLanguageQuery: string;
    sql: string;
    datasetFingerprint: string;
    resultSummary?: string;
  }): void {
    const now = new Date().toISOString();
    const normalizedInputSql = normalizeSql(params.sql);

    // 查找相同 SQL（标准化后比较，避免格式差异导致重复）
    const existing = this.memory.entries.find((e) => normalizeSql(e.sql) === normalizedInputSql);
    if (existing) {
      existing.useCount++;
      existing.timestamp = now;
      if (params.resultSummary) {
        existing.resultSummary = params.resultSummary;
      }
      this.save();
      return;
    }

    // 新建 entry
    const entry: QueryMemoryEntry = {
      id: `qm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      naturalLanguageQuery: params.naturalLanguageQuery,
      sql: params.sql,
      datasetFingerprint: params.datasetFingerprint,
      timestamp: now,
      useCount: 1,
      success: true,
      resultSummary: params.resultSummary,
    };

    this.memory.entries.push(entry);

    // 容量闸：超限时淘汰
    if (this.memory.entries.length > this.memory.maxEntries) {
      this.evictLowestScore();
    }

    this.save();
  }

  // ==========================================================================
  // 失败查询入库
  // ==========================================================================

  /**
   * 记录一次失败查询（独立存储，不影响成功查询容量闸）
   *
   * 规则：
   * - 最多保留 MAX_FAILED_ENTRIES 条
   * - 超限时淘汰最早的条目
   * - 入库失败不影响主流程（try/catch + warn）
   */
  recordFailedQuery(params: {
    naturalLanguageQuery: string;
    sql: string;
    errorMessage: string;
    datasetFingerprint?: string;
  }): void {
    try {
      const entry: FailedQueryEntry = {
        id: `fq_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        naturalLanguageQuery: params.naturalLanguageQuery,
        sql: params.sql,
        datasetFingerprint: params.datasetFingerprint ?? this.currentDatasetFingerprint ?? "",
        timestamp: new Date().toISOString(),
        failureCategory: classifyError(params.errorMessage),
        errorMessage: params.errorMessage.slice(0, 500), // 截断过长错误消息
      };

      this.failedQueries.push(entry);

      // 超限淘汰
      if (this.failedQueries.length > QueryMemoryManager.MAX_FAILED_ENTRIES) {
        this.failedQueries = this.failedQueries.slice(-QueryMemoryManager.MAX_FAILED_ENTRIES);
      }

      this.saveFailedQueries();
      logger.debug(`Failed query recorded: ${entry.failureCategory} — ${entry.errorMessage.slice(0, 80)}`);
    } catch (err) {
      console.warn("[QueryMemory] Failed to record failed query:", err);
    }
  }

  /** 获取所有失败查询（调试/诊断用） */
  getFailedQueries(): FailedQueryEntry[] {
    return [...this.failedQueries];
  }

  /** 从持久化加载失败查询 */
  private loadFailedQueries(): void {
    try {
      const loaded = this.persistence.readConfig<FailedQueryEntry[]>("failed_queries", "project");
      if (Array.isArray(loaded)) {
        this.failedQueries = loaded;
      }
    } catch {
      this.failedQueries = [];
    }
  }

  /** 持久化失败查询 */
  private saveFailedQueries(): void {
    try {
      this.persistence.writeConfig("failed_queries", this.failedQueries, "project");
    } catch (err) {
      console.warn("[QueryMemory] Failed to persist failed queries:", err);
    }
  }

  /**
   * 召回相关查询（用于注入 system prompt）
   *
   * 规则：
   * - 相关性闸：只返回涉及当前数据集的查询
   * - 按加权分数排序（频次 × 新近）
   * - 最多返回 3 条
   */
  recallRelevantQueries(limit = 3): QueryMemoryEntry[] {
    if (!this.currentDatasetFingerprint) return [];

    const relevant = this.memory.entries.filter(
      (e) => e.datasetFingerprint === this.currentDatasetFingerprint
    );

    // 按加权分数排序
    const scored = relevant.map((e) => ({
      entry: e,
      score: this.calculateScore(e),
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((s) => s.entry);
  }

  /** 生成注入 system prompt 的文本 */
  generatePromptInjection(): string {
    const relevant = this.recallRelevantQueries(3);
    const hasStale = this.hasStaleQueries();

    if (relevant.length === 0 && !hasStale) return "";

    let result = "";

    if (relevant.length > 0) {
      const lines = relevant.map((e) => {
        const summary = e.resultSummary ? ` → ${e.resultSummary}` : "";
        return `- "${e.naturalLanguageQuery}" → SQL: ${e.sql}${summary}`;
      });
      result = `\n\n## Query Memory\n\nPreviously answered similar questions:\n${lines.join("\n")}`;
    }

    if (hasStale) {
      result += `\n\n⚠️ Schema Change Detected: The dataset schema has changed since some previous queries were recorded. Some query memory entries may be outdated and should be re-validated.`;
    }

    return result;
  }

  /** 检查是否有过时的查询条目 */
  private hasStaleQueries(): boolean {
    if (!this.currentDatasetFingerprint) return false;
    return this.memory.entries.some(
      (e) => e.datasetFingerprint && e.datasetFingerprint !== this.currentDatasetFingerprint
    );
  }

  // ==========================================================================
  // 容量闸算法
  // ==========================================================================

  /**
   * 计算条目加权分数
   *
   * score = log(useCount + 1) × exp(-daysAgo / 7) × relevanceScore
   * - frequencyScore = log(useCount + 1)：避免高 useCount 查询永远不被淘汰
   * - recencyWeight = exp(-daysAgo / 7)：指数衰减，半衰期 7 天
   * - relevanceScore：数据集指纹匹配度（完全匹配 1.0，否则 0.5）
   */
  private calculateScore(entry: QueryMemoryEntry): number {
    const daysAgo = (Date.now() - new Date(entry.timestamp).getTime()) / (1000 * 60 * 60 * 24);
    const recencyWeight = Math.exp(-daysAgo / 7);
    const frequencyScore = Math.log(entry.useCount + 1);
    const relevanceScore =
      this.currentDatasetFingerprint && entry.datasetFingerprint === this.currentDatasetFingerprint
        ? 1.0
        : 0.5;
    return frequencyScore * recencyWeight * relevanceScore;
  }

  /** 淘汰最低分的条目（v0.10 A-5：pinned 条目不参与容量淘汰） */
  private evictLowestScore(): void {
    if (this.memory.entries.length <= this.memory.maxEntries) return;

    // pinned 条目跳过淘汰：只在没有可淘汰候选时放弃淘汰
    const candidates = this.memory.entries
      .map((e, i) => ({ index: i, entry: e, score: this.calculateScore(e) }))
      .filter((c) => !c.entry.pinned);
    if (candidates.length === 0) return;

    candidates.sort((a, b) => a.score - b.score);

    // 删除最低分的（可能有多个同分，只删一个）
    this.memory.entries.splice(candidates[0].index, 1);
  }

  // ==========================================================================
  // v0.10 A-5: 固定 / 取消固定（长期记忆）
  // ==========================================================================

  /**
   * 设置条目的固定状态
   *
   * @returns 是否成功（条目不存在返回 false）
   */
  setPinned(entryId: string, pinned: boolean): boolean {
    const entry = this.memory.entries.find((e) => e.id === entryId);
    if (!entry) return false;
    entry.pinned = pinned;
    this.save();
    return true;
  }

  /**
   * 获取固定条目（注入 L0 导航层"用户的高频/固定分析"，每条一行：问题 + 表名）
   *
   * 排序：新者优先；上限 limit（默认 PINNED_INJECTION_LIMIT=10，由调用方传参控制）
   */
  getPinnedEntries(limit = 10): QueryMemoryEntry[] {
    return this.memory.entries
      .filter((e) => e.pinned)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  // ==========================================================================
  // 持久化
  // ==========================================================================

  private save(): void {
    this.persistence.saveQueryMemory(this.memory, "project");
  }

  /** 获取当前记忆状态（调试用） */
  getMemory(): QueryMemory {
    return this.memory;
  }
}
