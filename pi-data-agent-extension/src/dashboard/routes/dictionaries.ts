/**
 * Dashboard — 字典路由
 *
 * GET   /api/dictionaries
 * GET   /api/dictionaries/:table
 * PATCH /api/dictionaries/:table/:column
 * PATCH /api/dictionaries/:table
 * GET   /api/dictionaries/:table/export?format=markdown
 *
 * v0.7 新增：
 * POST   /api/dictionaries/:table/infer            AI 推断缺失字段
 * POST   /api/dictionaries/:table/infer-selected    AI 重新推断选中字段
 * GET    /api/dictionaries/:table/:column/suggestion  获取单列 AI 建议
 * PATCH  /api/dictionaries/:table/:column/review     审核单列
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { DictionaryStore } from "../services/dictionary-store.js";
import type { DashboardDependencies } from "../server.js";
import { RevisionConflictError } from "../services/atomic-store.js";
import { inferDictionary } from "../../dictionary/inference/infer-dictionary.js";
import type { DictionaryInferenceMode } from "../../types.js";
import type { InferenceResult } from "../../dictionary/inference/types.js";

export function createDictionariesRouter(deps: DashboardDependencies): Router {
  const router = Router();
  const store = new DictionaryStore(deps.projectDir, deps.engine);

  /** 表列表 */
  router.get("/api/dictionaries", async (_req: Request, res: Response) => {
    try {
      const { tables, revision } = await store.getTableList();
      res.json({
        data: { tables, revision },
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "获取字典失败";
      res.status(500).json({
        error: { code: "DICTIONARY_READ_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  /** 单张表字段列表 */
  router.get("/api/dictionaries/:table", (req: Request, res: Response) => {
    const table = req.params.table as string;

    // 安全校验
    if (!/^[\w-]+$/.test(table)) {
      res.status(400).json({
        error: { code: "INVALID_TABLE_NAME", message: "无效的表名" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    try {
      const { entry, revision } = store.getTable(table);
      if (!entry) {
        res.status(404).json({
          error: { code: "TABLE_NOT_FOUND", message: `表 "${table}" 在字典中不存在` },
          meta: { requestId: randomUUID() },
        });
        return;
      }

      res.json({
        data: { entry, revision },
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "获取字典失败";
      res.status(500).json({
        error: { code: "DICTIONARY_READ_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  /** 单字段编辑 */
  router.patch("/api/dictionaries/:table/:column", (req: Request, res: Response) => {
    const table = req.params.table as string;
    const column = req.params.column as string;

    if (!/^[\w-]+$/.test(table) || !/^[\w-]+$/.test(column)) {
      res.status(400).json({
        error: { code: "INVALID_IDENTIFIER", message: "无效的表名或字段名" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    const { description, notes, status, userMeaning } = req.body;
    const expectedRevision = req.body.expectedRevision ?? -1;

    try {
      const result = store.updateColumn(table, column, {
        description,
        userMeaning,
        notes,
        status,
      }, expectedRevision);

      res.json({
        data: result,
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        res.status(409).json({
          error: { code: err.code, message: err.message },
          meta: { requestId: randomUUID() },
        });
        return;
      }
      const msg = err instanceof Error ? err.message : "更新字典失败";
      res.status(500).json({
        error: { code: "DICTIONARY_UPDATE_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  /** 批量确认 */
  router.patch("/api/dictionaries/:table", (req: Request, res: Response) => {
    const table = req.params.table as string;

    if (!/^[\w-]+$/.test(table)) {
      res.status(400).json({
        error: { code: "INVALID_TABLE_NAME", message: "无效的表名" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    const { operation, columns, expectedRevision } = req.body;

    if (operation !== "confirm-selected" || !Array.isArray(columns)) {
      res.status(400).json({
        error: { code: "INVALID_BATCH_OPERATION", message: "无效的批量操作参数" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    try {
      const result = store.batchConfirm(table, columns, expectedRevision ?? -1);
      res.json({
        data: result,
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        res.status(409).json({
          error: { code: err.code, message: err.message },
          meta: { requestId: randomUUID() },
        });
        return;
      }
      const msg = err instanceof Error ? err.message : "批量确认失败";
      res.status(500).json({
        error: { code: "DICTIONARY_BATCH_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  /** 导出 Markdown */
  router.get("/api/dictionaries/:table/export", (req: Request, res: Response) => {
    const table = req.params.table as string;
    const format = req.query.format as string;

    if (format !== "markdown") {
      res.status(400).json({
        error: { code: "UNSUPPORTED_FORMAT", message: "仅支持 markdown 格式导出" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    if (!/^[\w-]+$/.test(table)) {
      res.status(400).json({
        error: { code: "INVALID_TABLE_NAME", message: "无效的表名" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    try {
      const md = store.exportMarkdown(table);
      if (!md) {
        res.status(404).json({
          error: { code: "TABLE_NOT_FOUND", message: `表 "${table}" 在字典中不存在` },
          meta: { requestId: randomUUID() },
        });
        return;
      }

      res.type("text/markdown").send(md);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "导出失败";
      res.status(500).json({
        error: { code: "DICTIONARY_EXPORT_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  // =========================================================================
  // v0.7 — AI 推断 & 审核
  // =========================================================================

  /**
   * POST /api/dictionaries/:table/infer
   * 为指定表的缺失字段生成 AI 候选含义
   *
   * Body: { mode: "empty-only" | "selected" | "force", columns?: string[], expectedRevision: number }
   */
  router.post("/api/dictionaries/:table/infer", async (req: Request, res: Response) => {
    const table = req.params.table as string;

    // 安全校验
    if (!/^[\w-]+$/.test(table)) {
      res.status(400).json({
        error: { code: "INVALID_TABLE_NAME", message: "无效的表名" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    // 参数校验
    const { mode, columns, expectedRevision } = req.body;
    const validModes: DictionaryInferenceMode[] = ["empty-only", "selected", "force"];
    if (!mode || !validModes.includes(mode)) {
      res.status(400).json({
        error: { code: "INVALID_MODE", message: `mode 必须是 ${validModes.join("/")} 之一` },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    if (mode === "selected" && (!Array.isArray(columns) || columns.length === 0)) {
      res.status(400).json({
        error: { code: "MISSING_COLUMNS", message: "mode 为 selected 时必须提供 columns 数组" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    // 检查 DataDictionaryManager 是否可用
    const dictManager = deps.dictionaryManager;
    if (!dictManager) {
      res.status(503).json({
        error: { code: "DICTIONARY_UNAVAILABLE", message: "数据字典未加载，请先在 TUI 中加载数据集" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    // 检查 DuckDB Engine 是否可用
    if (!deps.engine) {
      res.status(503).json({
        error: { code: "DICTIONARY_UNAVAILABLE", message: "数据字典未加载，请先在 TUI 中加载数据集" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    // 检查 LLM 是否可用
    if (!deps.callLLM) {
      res.status(503).json({
        error: { code: "LLM_UNAVAILABLE", message: "未配置 AI 模型，推断功能不可用" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    // 检查字典 entry 是否存在
    const { entry, revision } = store.getTable(table);
    if (!entry) {
      res.status(404).json({
        error: { code: "TABLE_NOT_FOUND", message: `表 "${table}" 在字典中不存在` },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    // 乐观锁校验
    if (expectedRevision !== undefined && expectedRevision !== -1 && expectedRevision !== revision) {
      res.status(409).json({
        error: { code: "REVISION_CONFLICT", message: "数据已被其他操作修改，请刷新后重试" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    try {
      // 调用推断（注入 callModel）
      const callModel = (prompt: string, _responseFormat?: object) => deps.callLLM!(prompt);

      const INFERENCE_TIMEOUT_MS = 30_000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("推断超时")), INFERENCE_TIMEOUT_MS);
      });

      const result: InferenceResult = await Promise.race([
        inferDictionary({
          tableName: table,
          engine: deps.engine,
          dictionaryManager: dictManager,
          mode,
          selectedColumns: columns,
          projectDir: deps.projectDir,
          callModel,
        }),
        timeoutPromise,
      ]);

      // 如果有成功的 suggestions，应用到 DictionaryStore
      let applied = 0;
      let skipped = 0;

      if (result.suggestions.length > 0) {
        // 通过 DictionaryStore 的 AtomicStore 写入（保持 revision 一致性）
        const data = store.read();
        if (data) {
          const lockedStatuses = new Set(["user-confirmed", "user-corrected"]);
          const newEntries = data.data.map((e) => {
            if (e.tableName !== table) return e;

            return {
              ...e,
              columns: e.columns.map((col) => {
                const suggestion = result.suggestions.find((s) => s.column === col.name);
                if (!suggestion) return col;
                if (lockedStatuses.has(col.status)) {
                  skipped++;
                  return col;
                }

                applied++;
                return {
                  ...col,
                  inferredMeaning: suggestion.suggestedDescription,
                  aliases: suggestion.suggestedAliases,
                  status: suggestion.status,
                  suggestion: {
                    confidence: suggestion.confidence,
                    confidenceLevel: suggestion.confidenceLevel,
                    evidence: suggestion.evidence,
                    uncertainties: suggestion.uncertainties,
                    modelVersion: suggestion.modelVersion,
                    generatedAt: suggestion.generatedAt,
                    sourceSchemaRevision: suggestion.sourceSchemaRevision,
                  },
                };
              }),
            };
          });

          // 使用 AtomicStore 写入，确保原子性
          store.write(newEntries, data.revision, `dictionary:${table}:infer`);
        }
      } else {
        // 没有新 suggestions，全部算作 skipped
        skipped = result.errors.length;
      }

      res.json({
        data: {
          applied,
          skipped,
          suggestions: result.suggestions,
          errors: result.errors,
        },
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "推断失败";
      const isTimeout = msg === "推断超时";
      res.status(isTimeout ? 504 : 500).json({
        error: { code: isTimeout ? "INFERENCE_TIMEOUT" : "INFERENCE_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  /**
   * POST /api/dictionaries/:table/infer-selected
   * 重新推断选中字段
   *
   * Body: { columns: string[], expectedRevision: number }
   */
  router.post("/api/dictionaries/:table/infer-selected", async (req: Request, res: Response) => {
    const table = req.params.table as string;

    if (!/^[\w-]+$/.test(table)) {
      res.status(400).json({
        error: { code: "INVALID_TABLE_NAME", message: "无效的表名" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    const { columns, expectedRevision } = req.body;
    if (!Array.isArray(columns) || columns.length === 0) {
      res.status(400).json({
        error: { code: "MISSING_COLUMNS", message: "必须提供 columns 数组" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    const dictManager = deps.dictionaryManager;
    if (!dictManager) {
      res.status(503).json({
        error: { code: "DICTIONARY_UNAVAILABLE", message: "数据字典未加载，请先在 TUI 中加载数据集" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    if (!deps.engine) {
      res.status(503).json({
        error: { code: "DICTIONARY_UNAVAILABLE", message: "数据字典未加载，请先在 TUI 中加载数据集" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    if (!deps.callLLM) {
      res.status(503).json({
        error: { code: "LLM_UNAVAILABLE", message: "未配置 AI 模型，推断功能不可用" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    const { entry, revision } = store.getTable(table);
    if (!entry) {
      res.status(404).json({
        error: { code: "TABLE_NOT_FOUND", message: `表 "${table}" 在字典中不存在` },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    if (expectedRevision !== undefined && expectedRevision !== -1 && expectedRevision !== revision) {
      res.status(409).json({
        error: { code: "REVISION_CONFLICT", message: "数据已被其他操作修改，请刷新后重试" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    try {
      const callModel = (prompt: string, _responseFormat?: object) => deps.callLLM!(prompt);

      const INFERENCE_TIMEOUT_MS = 30_000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("推断超时")), INFERENCE_TIMEOUT_MS);
      });

      const result: InferenceResult = await Promise.race([
        inferDictionary({
          tableName: table,
          engine: deps.engine,
          dictionaryManager: dictManager,
          mode: "selected",
          selectedColumns: columns,
          projectDir: deps.projectDir,
          callModel,
        }),
        timeoutPromise,
      ]);

      let applied = 0;
      let skipped = 0;

      if (result.suggestions.length > 0) {
        const data = store.read();
        if (data) {
          const lockedStatuses = new Set(["user-confirmed", "user-corrected"]);
          const newEntries = data.data.map((e) => {
            if (e.tableName !== table) return e;

            return {
              ...e,
              columns: e.columns.map((col) => {
                const suggestion = result.suggestions.find((s) => s.column === col.name);
                if (!suggestion) return col;
                if (lockedStatuses.has(col.status)) {
                  skipped++;
                  return col;
                }

                applied++;
                return {
                  ...col,
                  inferredMeaning: suggestion.suggestedDescription,
                  aliases: suggestion.suggestedAliases,
                  status: suggestion.status,
                  suggestion: {
                    confidence: suggestion.confidence,
                    confidenceLevel: suggestion.confidenceLevel,
                    evidence: suggestion.evidence,
                    uncertainties: suggestion.uncertainties,
                    modelVersion: suggestion.modelVersion,
                    generatedAt: suggestion.generatedAt,
                    sourceSchemaRevision: suggestion.sourceSchemaRevision,
                  },
                };
              }),
            };
          });

          store.write(newEntries, data.revision, `dictionary:${table}:infer-selected`);
        }
      } else {
        skipped = result.errors.length;
      }

      res.json({
        data: {
          applied,
          skipped,
          suggestions: result.suggestions,
          errors: result.errors,
        },
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "推断失败";
      const isTimeout = msg === "推断超时";
      res.status(isTimeout ? 504 : 500).json({
        error: { code: isTimeout ? "INFERENCE_TIMEOUT" : "INFERENCE_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  /**
   * GET /api/dictionaries/:table/:column/suggestion
   * 获取单列的 AI 建议详情
   */
  router.get("/api/dictionaries/:table/:column/suggestion", (req: Request, res: Response) => {
    const table = req.params.table as string;
    const column = req.params.column as string;

    if (!/^[\w-]+$/.test(table) || !/^[\w-]+$/.test(column)) {
      res.status(400).json({
        error: { code: "INVALID_IDENTIFIER", message: "无效的表名或字段名" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    const { entry, revision } = store.getTable(table);
    if (!entry) {
      res.status(404).json({
        error: { code: "TABLE_NOT_FOUND", message: `表 "${table}" 在字典中不存在` },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    const col = entry.columns.find((c) => c.name === column);
    if (!col) {
      res.status(404).json({
        error: { code: "COLUMN_NOT_FOUND", message: `字段 "${column}" 在表 "${table}" 中不存在` },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    res.json({
      data: {
        column: col.name,
        type: col.type,
        status: col.status,
        inferredMeaning: col.inferredMeaning,
        userMeaning: col.userMeaning,
        suggestion: col.suggestion ?? null,
        review: col.review ?? null,
        revision,
      },
      meta: { requestId: randomUUID() },
    });
  });

  /**
   * PATCH /api/dictionaries/:table/:column/review
   * 审核单列
   *
   * Body: { action: "confirm" | "correct" | "uncertain", description?: string, expectedRevision: number }
   */
  router.patch("/api/dictionaries/:table/:column/review", (req: Request, res: Response) => {
    const table = req.params.table as string;
    const column = req.params.column as string;

    if (!/^[\w-]+$/.test(table) || !/^[\w-]+$/.test(column)) {
      res.status(400).json({
        error: { code: "INVALID_IDENTIFIER", message: "无效的表名或字段名" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    const { action, description, expectedRevision } = req.body;
    const validActions = ["confirm", "correct", "uncertain"];
    if (!action || !validActions.includes(action)) {
      res.status(400).json({
        error: { code: "INVALID_ACTION", message: `action 必须是 ${validActions.join("/")} 之一` },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    if (action === "correct" && !description) {
      res.status(400).json({
        error: { code: "MISSING_DESCRIPTION", message: "action 为 correct 时必须提供 description" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    // 乐观锁校验
    const currentData = store.read();
    if (!currentData) {
      res.status(404).json({
        error: { code: "DICTIONARY_NOT_FOUND", message: "字典数据不存在" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    const rev = expectedRevision ?? -1;
    if (rev !== -1 && rev !== currentData.revision) {
      res.status(409).json({
        error: { code: "REVISION_CONFLICT", message: "数据已被其他操作修改，请刷新后重试" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    // 查找目标列
    const tableEntry = currentData.data.find((e) => e.tableName === table);
    if (!tableEntry) {
      res.status(404).json({
        error: { code: "TABLE_NOT_FOUND", message: `表 "${table}" 在字典中不存在` },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    const colIndex = tableEntry.columns.findIndex((c) => c.name === column);
    if (colIndex === -1) {
      res.status(404).json({
        error: { code: "COLUMN_NOT_FOUND", message: `字段 "${column}" 在表 "${table}" 中不存在` },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    try {
      const col = tableEntry.columns[colIndex];
      const now = new Date().toISOString();

      // 映射 API action → 列级状态更新
      // 通过 DictionaryStore 写入以保持 revision 一致性
      type ColType = typeof col;
      const updatedCol: ColType = (() => {
        switch (action) {
          case "confirm":
            return {
              ...col,
              status: "user-confirmed" as const,
              confirmedAt: now,
              validated: true,
              review: {
                action: "confirmed" as const,
                reviewedAt: now,
              },
            };
          case "correct":
            return {
              ...col,
              status: "user-corrected" as const,
              userMeaning: description,
              confirmedAt: now,
              validated: true,
              review: {
                action: "corrected" as const,
                reviewedAt: now,
                originalSuggestion: col.inferredMeaning,
              },
            };
          case "uncertain":
            return {
              ...col,
              status: "uncertain" as const,
              confirmedAt: now,
              validated: false,
              review: {
                action: "uncertain" as const,
                reviewedAt: now,
              },
            };
          default:
            return col;
        }
      })();

      // 写入 AtomicStore
      const newEntries = currentData.data.map((e) => {
        if (e.tableName !== table) return e;
        return {
          ...e,
          columns: e.columns.map((c, i) => (i === colIndex ? updatedCol : c)),
        };
      });

      store.write(newEntries, currentData.revision, `dictionary:${table}.${column}:review`);

      res.json({
        data: {
          column: updatedCol.name,
          status: updatedCol.status,
          review: updatedCol.review,
        },
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        res.status(409).json({
          error: { code: err.code, message: err.message },
          meta: { requestId: randomUUID() },
        });
        return;
      }
      const msg = err instanceof Error ? err.message : "审核失败";
      res.status(500).json({
        error: { code: "REVIEW_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  return router;
}
