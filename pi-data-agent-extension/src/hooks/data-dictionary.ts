/**
 * S3.3 data-dictionary — 数据字典懒加载 + 列级用户确认
 *
 * 触发：query_data / describe_data / transform_data 执行前
 * 逻辑：
 * 1. 检查目标表是否已有字典
 * 2. 无则 DESCRIBE + 样本 → 推断语义
 * 3. 用户可通过自然语言或 confirm_dictionary 工具确认/修正/标记不确定
 * 4. 列级状态：ai-guessed / user-confirmed / user-corrected / uncertain
 * 5. 持久化到 project + global 层级
 *
 * MVP 简化：无 LLM 接入，基于列名模式做基础推断
 */

import type { DataDictionaryEntry, ColumnSemantic, ColumnSemanticStatus, DictionaryInferenceMode, DictionarySuggestion, PersistenceLevel } from "../types.js";
import type { PersistenceManager } from "../persistence.js";
import type { DuckDBEngine } from "../engine/duckdb.js";
import { createHash } from "node:crypto";
import { maskPII } from "../pii-guard.js";

/** 数据字典管理器 */
export class DataDictionaryManager {
  private cache: Map<string, DataDictionaryEntry> = new Map();
  private persistence: PersistenceManager;

  constructor(persistence: PersistenceManager) {
    this.persistence = persistence;
    // 从持久化恢复（global + project 合并）
    const merged = persistence.loadMergedDataDictionary();
    for (const [name, entry] of merged.entries()) {
      // 迁移：旧数据没有列级 status，需要初始化
      const migrated = this.migrateEntry(entry);
      this.cache.set(name, migrated);
    }
  }

  /** 迁移旧格式字典 → 新格式（列级 status） */
  private migrateEntry(entry: DataDictionaryEntry): DataDictionaryEntry {
    if (!entry.columns) return entry;
    for (const col of entry.columns) {
      if (!col.status) {
        // 旧格式迁移：entry 级别状态映射到列级别
        if (entry.status === "validated") {
          col.status = "user-confirmed";
        } else if (entry.status === "user-corrected") {
          col.status = "user-corrected";
        } else {
          col.status = "ai-guessed";
        }
      }
      if (col.validated && !col.confirmedAt) {
        col.confirmedAt = entry.validatedAt ?? entry.generatedAt;
      }
    }
    return entry;
  }

  /** 检查表是否有字典（ai-guessed 也算，避免死锁） */
  hasDictionary(tableName: string): boolean {
    return this.cache.has(tableName);
  }

  /** 检查字典是否经过用户确认（entry 级别，所有列都确认才算） */
  isValidated(tableName: string): boolean {
    const entry = this.cache.get(tableName);
    if (!entry) return false;
    return entry.columns.every(
      (c) => c.status === "user-confirmed" || c.status === "user-corrected"
    );
  }

  /** 获取表字典（如有） */
  getDictionary(tableName: string): DataDictionaryEntry | undefined {
    return this.cache.get(tableName);
  }

  /** 获取所有字典 */
  getAllDictionaries(): DataDictionaryEntry[] {
    return Array.from(this.cache.values());
  }

  /**
   * 删除表字典（表被 DROP 后清理孤儿条目）。
   *
   * 字典按 global → project → session 三级合并（loadMergedDataDictionary），
   * 只删内存 cache 会在下次加载时被高层级同名条目"复活"，
   * 故必须逐级落盘移除。**只回写确实包含该表的级别**——
   * saveDataDictionary([]) 语义是"该级别已明确清空"，误写会连带清空无关表。
   *
   * @returns 是否确实删除了条目（原本不存在返回 false，幂等）
   */
  removeDictionary(tableName: string): boolean {
    if (!this.cache.has(tableName)) return false;
    this.cache.delete(tableName);

    const levels: PersistenceLevel[] = ["global", "project", "session"];
    for (const level of levels) {
      const entries = this.persistence.loadDataDictionary(level);
      if (!entries || entries.length === 0) continue;
      const filtered = entries.filter((e) => e.tableName !== tableName);
      // 该级别没有这张表 → 不回写，避免用空数组误清空整级
      if (filtered.length === entries.length) continue;
      this.persistence.saveDataDictionary(filtered, level);
    }

    return true;
  }

  /** 计算 schema fingerprint（MD5 of DESCRIBE result + row count） */
  async computeFingerprint(tableName: string, engine: DuckDBEngine): Promise<string> {
    try {
      const schema = await engine.getSchema(tableName);
      const overview = await engine.getTableOverview(tableName);
      const schemaStr = JSON.stringify(
        schema.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable }))
      );
      const raw = `${schemaStr}_${overview.rowCount}`;
      return createHash("md5").update(raw).digest("hex");
    } catch {
      return "";
    }
  }

  /**
   * 懒加载表字典
   *
   * 如果表没有字典，生成初步推断并返回给用户确认。
   * 返回 true 表示字典已就绪（已有或新生成）。
   */
  async ensureDictionary(
    tableName: string,
    engine: DuckDBEngine
  ): Promise<{ entry: DataDictionaryEntry; isNew: boolean }> {
    const existing = this.cache.get(tableName);
    if (existing && this.isValidated(tableName)) {
      return { entry: existing, isNew: false };
    }

    // 生成新字典
    const entry = await this.generateDictionary(tableName, engine);
    this.cache.set(tableName, entry);
    this.save();

    return { entry, isNew: true };
  }

  /**
   * 生成数据字典
   *
   * MVP：基于列名模式做基础推断，无 LLM
   */
  private async generateDictionary(tableName: string, engine: DuckDBEngine): Promise<DataDictionaryEntry> {
    const schema = await engine.getSchema(tableName);
    const sample = await engine.getSample(tableName, 3);

    const columns: ColumnSemantic[] = schema.map((col) => ({
      name: col.name,
      type: col.type,
      inferredMeaning: this.inferColumnMeaning(col.name, col.type),
      sampleValues: sample.slice(0, 3).map((row) => {
        const raw = String(row[schema.findIndex((c) => c.name === col.name)] ?? "");
        return maskPII(raw).masked;
      }),
      status: "ai-guessed",
      validated: false,
    }));

    const fingerprint = await this.computeFingerprint(tableName, engine);

    return {
      tableName,
      columns,
      generatedAt: new Date().toISOString(),
      status: "ai-guessed",
      schemaFingerprint: fingerprint,
    };
  }

  /** 列名模式推断（MVP 简化版） */
  private inferColumnMeaning(name: string, type: string): string {
    const lower = name.toLowerCase();

    // ID / 主键
    if (/^id$|_id$|^pk$|^key$/.test(lower)) return "唯一标识符";
    // 时间
    if (/date|time|timestamp|created|updated|at$/.test(lower)) return "时间戳";
    // 金额
    if (/price|cost|amount|fee|revenue|income|salary|wage/.test(lower)) return "金额";
    // 数量
    if (/count|qty|quantity|num|total|sum/.test(lower)) return "数量";
    // 名称
    if (/name|title|label|description/.test(lower)) return "名称/描述";
    // 状态
    if (/status|state|type|category|class/.test(lower)) return "分类/状态";
    // 地理位置
    if (/city|country|region|province|address|location|lat|lng|lon/.test(lower)) return "地理位置";
    // 用户相关
    if (/user|customer|client|member/.test(lower)) return "用户信息";
    // 布尔
    if (type === "BOOLEAN" || /is_|has_|can_|flag|active|enabled/.test(lower)) return "布尔标志";
    // 评分
    if (/score|rating|rank|grade|level/.test(lower)) return "评分/等级";
    // 渠道
    if (/channel|chnl|source|medium/.test(lower)) return "渠道来源";
    // 保费/理赔（保险领域）
    if (/premium|prem/.test(lower)) return "保费金额";
    if (/claim/.test(lower)) return "理赔金额";
    // 订单相关
    if (/order/.test(lower)) return "订单信息";

    return "未知语义（请确认）";
  }

  /** 仅刷新 schema fingerprint（不重新生成字典内容） */
  async refreshFingerprint(tableName: string, engine: DuckDBEngine): Promise<void> {
    const entry = this.cache.get(tableName);
    if (!entry) return;
    try {
      entry.schemaFingerprint = await this.computeFingerprint(tableName, engine);
      entry.generatedAt = new Date().toISOString();
      this.cache.set(tableName, entry);
      this.save();
    } catch (err) {
      console.warn(`[DataDictionary] Failed to refresh fingerprint for ${tableName}:`, err);
    }
  }

  // ============================================================================
  // 列级用户确认 / 修正 / 标记不确定（v0.3 新增）
  // ============================================================================

  /** 确认全部字段 → user-confirmed */
  confirmAllColumns(tableName: string): boolean {
    const entry = this.cache.get(tableName);
    if (!entry) return false;

    const now = new Date().toISOString();
    for (const col of entry.columns) {
      col.status = "user-confirmed";
      col.confirmedAt = now;
      col.validated = true;
    }
    entry.status = "validated";
    entry.validatedBy = "user";
    entry.validatedAt = now;

    this.cache.set(tableName, entry);
    this.save();
    return true;
  }

  /** 修改单个/多个字段含义 → user-corrected */
  updateColumnMeanings(
    tableName: string,
    updates: Array<{ columnName: string; userMeaning: string }>
  ): boolean {
    const entry = this.cache.get(tableName);
    if (!entry) return false;

    const now = new Date().toISOString();
    for (const { columnName, userMeaning } of updates) {
      const col = entry.columns.find((c) => c.name === columnName);
      if (!col) continue;
      col.userMeaning = userMeaning;
      col.status = "user-corrected";
      col.confirmedAt = now;
      col.validated = true;
    }

    entry.generatedAt = now;
    this.cache.set(tableName, entry);
    this.save();
    return true;
  }

  /** 标记字段为不确定 */
  markColumnsUncertain(tableName: string, columnNames: string[]): boolean {
    const entry = this.cache.get(tableName);
    if (!entry) return false;

    const now = new Date().toISOString();
    for (const name of columnNames) {
      const col = entry.columns.find((c) => c.name === name);
      if (!col) continue;
      col.status = "uncertain";
      col.confirmedAt = now;
      col.validated = false;
    }

    entry.generatedAt = now;
    this.cache.set(tableName, entry);
    this.save();
    return true;
  }

  /** 获取字段的有效含义（优先 userMeaning，其次 inferredMeaning） */
  getColumnMeaning(tableName: string, columnName: string): string | undefined {
    const entry = this.cache.get(tableName);
    if (!entry) return undefined;
    const col = entry.columns.find((c) => c.name === columnName);
    if (!col) return undefined;
    return col.userMeaning ?? col.inferredMeaning;
  }

  /**
   * 获取字段的有效含义及其状态
   * 返回含义文本和状态标识
   */
  getColumnMeaningWithStatus(tableName: string, columnName: string): { meaning: string; status: ColumnSemanticStatus } | undefined {
    const entry = this.cache.get(tableName);
    if (!entry) return undefined;
    const col = entry.columns.find((c) => c.name === columnName);
    if (!col) return undefined;
    const meaning = col.userMeaning ?? col.inferredMeaning;
    return meaning ? { meaning, status: col.status } : undefined;
  }

  /** 获取字段的当前状态 */
  getColumnStatus(tableName: string, columnName: string): ColumnSemanticStatus | undefined {
    const entry = this.cache.get(tableName);
    if (!entry) return undefined;
    const col = entry.columns.find((c) => c.name === columnName);
    return col?.status;
  }

  /** 获取所有不确定字段 */
  getUncertainColumns(tableName: string): ColumnSemantic[] {
    const entry = this.cache.get(tableName);
    if (!entry) return [];
    return entry.columns.filter((c) => c.status === "uncertain");
  }

  /** 检查查询涉及的列中是否有不确定字段 */
  checkUncertainColumns(tableName: string, sql: string): ColumnSemantic[] {
    const entry = this.cache.get(tableName);
    if (!entry) return [];
    const sqlLower = sql.toLowerCase();
    return entry.columns.filter(
      (c) => c.status === "uncertain" && sqlLower.includes(c.name.toLowerCase())
    );
  }

  /** 旧版兼容：用户确认后更新字典状态（entry 级别） */
  confirmDictionary(tableName: string, corrections?: Partial<DataDictionaryEntry>): void {
    const entry = this.cache.get(tableName);
    if (!entry) return;

    entry.status = corrections ? "user-corrected" : "validated";
    if (corrections?.columns) {
      entry.columns = corrections.columns;
      // 同步更新列级状态
      const now = new Date().toISOString();
      for (const col of entry.columns) {
        col.status = corrections ? "user-corrected" : "user-confirmed";
        col.confirmedAt = now;
        col.validated = true;
      }
    }
    entry.generatedAt = new Date().toISOString();

    this.cache.set(tableName, entry);
    this.save();
  }

  /** 格式化字典为可读文本（含列级状态标注） */
  formatDictionary(entry: DataDictionaryEntry): string {
    const statusEmoji: Record<ColumnSemanticStatus, string> = {
      "ai-guessed": "🤖",
      "user-confirmed": "✅",
      "user-corrected": "✏️",
      uncertain: "❓",
    };

    const lines = [
      `Table: ${entry.tableName}`,
      `Entry Status: ${entry.status}`,
      "",
      "Columns:",
    ];
    for (const col of entry.columns) {
      const emoji = statusEmoji[col.status] ?? "🤖";
      const meaning = col.userMeaning
        ? `${col.userMeaning} (原: ${col.inferredMeaning})`
        : col.inferredMeaning;
      const samples = col.sampleValues?.length
        ? ` (e.g. ${col.sampleValues.slice(0, 3).join(", ")})`
        : "";
      lines.push(
        `  ${emoji} ${col.name} (${col.type}): ${meaning}${samples} [${col.status}]`
      );
    }
    return lines.join("\n");
  }

  /**
   * 格式化字典为 Agent prompt 注入格式
   *
   * 权重规则（Spec §14.1）：
   * - user-corrected: 标注 [已修正]，展示 userMeaning
   * - user-confirmed: 标注 [已确认]，展示 userMeaning ?? inferredMeaning
   * - ai-guessed: 标注 [AI推测]，展示 inferredMeaning，附带 "(未确认)" 警告
   * - uncertain: 标注 [不确定]，展示 inferredMeaning，附带 "(不可靠)" 严重警告
   * - 字段有 aliases 时一并列出
   * - suggestion 中有 uncertainties 时附在行尾
   */
  formatDictionaryForPrompt(tableName: string): string {
    const entry = this.cache.get(tableName);
    if (!entry) return "";

    const statusLabel: Record<ColumnSemanticStatus, string> = {
      "user-corrected": "[已修正]",
      "user-confirmed": "[已确认]",
      "ai-guessed": "[AI推测]",
      uncertain: "[不确定]",
    };

    const statusWarning: Partial<Record<ColumnSemanticStatus, string>> = {
      "ai-guessed": "(未确认)",
      uncertain: "(不可靠)",
    };

    const lines: string[] = [`Table: ${entry.tableName}`];

    for (const col of entry.columns) {
      const label = statusLabel[col.status] ?? "[AI推测]";
      const meaning = col.userMeaning ?? col.inferredMeaning ?? "—";

      const parts = [`${label} ${col.name} (${col.type}): ${meaning}`];

      // aliases
      if (col.aliases && col.aliases.length > 0) {
        parts.push(`aliases: ${col.aliases.join(", ")}`);
      }

      // 状态警告
      const warning = statusWarning[col.status];
      if (warning) {
        parts.push(warning);
      }

      // suggestion 中的 uncertainties
      if (col.suggestion?.uncertainties && col.suggestion.uncertainties.length > 0) {
        parts.push(`uncertainties: ${col.suggestion.uncertainties.join("; ")}`);
      }

      lines.push(`  ${parts.join(" | ")}`);
    }

    return lines.join("\n");
  }

  /** 生成操作提示文本（供 describe_data 展示） */
  formatDictionaryActions(tableName: string): string {
    const entry = this.cache.get(tableName);
    if (!entry) return "";

    const hasAiGuessed = entry.columns.some((c) => c.status === "ai-guessed");
    const hasUncertain = entry.columns.some((c) => c.status === "uncertain");

    if (!hasAiGuessed && !hasUncertain) {
      return "\n\n✅ 所有字段已确认。";
    }

    const lines = [
      "\n\n📋 数据字典操作提示：",
      "你可以通过自然语言告诉 Agent 以下操作：",
      "  • \"确认全部字段\" — 将所有字段标记为 user-confirmed",
      "  • \"把 <字段名> 改成 <新含义>\" — 修改字段含义",
      "  • \"把 <字段名> 标记为不确定\" — 标记字段语义不明",
    ];

    if (hasUncertain) {
      const uncertainCols = entry.columns
        .filter((c) => c.status === "uncertain")
        .map((c) => c.name);
      lines.push(`\n⚠️ 以下字段标记为不确定，使用时将提示风险：${uncertainCols.join(", ")}`);
    }

    return lines.join("\n");
  }

  // ============================================================================
  // v0.7 字典推断 & 审核
  // ============================================================================

  /**
   * 获取需要推断的列（根据 mode 筛选）
   *
   * - empty-only: inferredMeaning 为空或为默认占位 且 status 不是 user-confirmed/user-corrected
   * - selected: selectedColumns 中的列（跳过锁定状态）
   * - force: 所有列
   */
  getColumnsForInference(
    tableName: string,
    mode: DictionaryInferenceMode,
    selectedColumns?: string[]
  ): ColumnSemantic[] {
    const entry = this.cache.get(tableName);
    if (!entry) return [];

    const selectedSet = selectedColumns ? new Set(selectedColumns) : null;
    const lockedStatuses = new Set<ColumnSemanticStatus>(["user-confirmed", "user-corrected"]);

    return entry.columns.filter((col) => {
      switch (mode) {
        case "empty-only":
          if (lockedStatuses.has(col.status)) return false;
          return (
            !col.inferredMeaning ||
            col.inferredMeaning === "未知语义（请确认）"
          );
        case "selected":
          if (!selectedSet || !selectedSet.has(col.name)) return false;
          if (lockedStatuses.has(col.status)) return false;
          return true;
        case "force":
          return true;
      }
    });
  }

  /**
   * 应用推断结果到字典（不覆盖 user-confirmed/user-corrected）
   */
  applyInferenceResults(
    tableName: string,
    suggestions: DictionarySuggestion[]
  ): { applied: number; skipped: number } {
    const entry = this.cache.get(tableName);
    if (!entry) return { applied: 0, skipped: suggestions.length };

    const lockedStatuses = new Set<ColumnSemanticStatus>(["user-confirmed", "user-corrected"]);
    let applied = 0;
    let skipped = 0;

    for (const suggestion of suggestions) {
      const col = entry.columns.find((c) => c.name === suggestion.column);

      if (!col) {
        skipped++;
        continue;
      }

      // 不覆盖用户已锁定的列
      if (lockedStatuses.has(col.status)) {
        skipped++;
        continue;
      }

      // 应用推断结果
      col.inferredMeaning = suggestion.suggestedDescription;
      col.aliases = suggestion.suggestedAliases;
      col.status = suggestion.status;
      col.suggestion = {
        confidence: suggestion.confidence,
        confidenceLevel: suggestion.confidenceLevel,
        evidence: suggestion.evidence,
        uncertainties: suggestion.uncertainties,
        modelVersion: suggestion.modelVersion,
        generatedAt: suggestion.generatedAt,
        sourceSchemaRevision: suggestion.sourceSchemaRevision,
      };
      applied++;
    }

    if (applied > 0) {
      entry.generatedAt = new Date().toISOString();
      this.cache.set(tableName, entry);
      this.save();
    }

    return { applied, skipped };
  }

  /**
   * 审核字段（确认/修正/标记不确定）
   *
   * - confirmed: status -> user-confirmed, 写入 review
   * - corrected: status -> user-corrected, userMeaning = correctedDescription, 写入 review
   * - uncertain: status -> uncertain, 写入 review
   *
   * @returns 是否成功
   */
  reviewColumn(
    tableName: string,
    columnName: string,
    action: "confirmed" | "corrected" | "uncertain",
    correctedDescription?: string
  ): boolean {
    const entry = this.cache.get(tableName);
    if (!entry) return false;

    const col = entry.columns.find((c) => c.name === columnName);
    if (!col) return false;

    const now = new Date().toISOString();

    switch (action) {
      case "confirmed":
        col.status = "user-confirmed";
        col.confirmedAt = now;
        col.validated = true;
        col.review = {
          action: "confirmed",
          reviewedAt: now,
        };
        break;

      case "corrected":
        if (!correctedDescription) return false;
        col.status = "user-corrected";
        col.userMeaning = correctedDescription;
        col.confirmedAt = now;
        col.validated = true;
        col.review = {
          action: "corrected",
          reviewedAt: now,
          originalSuggestion: col.inferredMeaning,
        };
        break;

      case "uncertain":
        col.status = "uncertain";
        col.confirmedAt = now;
        col.validated = false;
        col.review = {
          action: "uncertain",
          reviewedAt: now,
        };
        break;
    }

    entry.generatedAt = now;
    this.cache.set(tableName, entry);
    this.save();
    return true;
  }

  /**
   * 批量审核（确认选中的高/中置信度字段）
   *
   * - confirmed: 只确认 confidenceLevel 为 high/medium 的列，跳过 low 和 uncertain
   * - uncertain: 标记为 uncertain
   */
  batchReviewColumns(
    tableName: string,
    columnNames: string[],
    action: "confirmed" | "uncertain"
  ): { applied: number; skipped: number; lowConfidenceSkipped: string[] } {
    const entry = this.cache.get(tableName);
    if (!entry) return { applied: 0, skipped: columnNames.length, lowConfidenceSkipped: [] };

    const columnNameSet = new Set(columnNames);
    let applied = 0;
    let skipped = 0;
    const lowConfidenceSkipped: string[] = [];

    for (const col of entry.columns) {
      if (!columnNameSet.has(col.name)) continue;

      switch (action) {
        case "confirmed": {
          // 只确认 high/medium 置信度，跳过 low 和无 suggestion 的列
          const confidenceLevel = col.suggestion?.confidenceLevel;
          if (confidenceLevel !== "high" && confidenceLevel !== "medium") {
            lowConfidenceSkipped.push(col.name);
            skipped++;
            continue;
          }
          col.status = "user-confirmed";
          col.confirmedAt = new Date().toISOString();
          col.validated = true;
          col.review = {
            action: "confirmed",
            reviewedAt: new Date().toISOString(),
          };
          applied++;
          break;
        }

        case "uncertain": {
          col.status = "uncertain";
          col.confirmedAt = new Date().toISOString();
          col.validated = false;
          col.review = {
            action: "uncertain",
            reviewedAt: new Date().toISOString(),
          };
          applied++;
          break;
        }
      }
    }

    // 跳过不在 entry 中的列名
    skipped += columnNames.filter((n) => !entry.columns.some((c) => c.name === n)).length;

    if (applied > 0) {
      entry.generatedAt = new Date().toISOString();
      this.cache.set(tableName, entry);
      this.save();
    }

    return { applied, skipped, lowConfidenceSkipped };
  }

  private save(): void {
    this.persistence.saveDataDictionary(this.getAllDictionaries(), "project");
    // 同时保存到 global 层级，确保跨项目复用
    // 沙箱环境可能无权限，失败时静默降级
    try {
      this.persistence.saveDataDictionary(this.getAllDictionaries(), "global");
    } catch (err) {
      // global 保存失败不影响 project 级持久化
    }
  }
}
