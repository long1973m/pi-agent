/**
 * Dashboard — 表卡片路由（v0.10 A-3）
 *
 * GET  /api/table-cards              全部卡片（导航用）
 * GET  /api/table-cards/:table       单张卡片
 * PUT  /api/table-cards/:table       用户编辑（expectedRevision 乐观锁，409 冲突）
 * POST /api/table-cards/:table/draft AI 起草（无 LLM 返回 503，同字典推断约定；无引擎/表不存在分别 503/404）
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { TableCardStore, RevisionConflictError } from "../../table-cards/store.js";
import type { TableCardUpdate } from "../../table-cards/store.js";
import { draftCardForTable } from "../../table-cards/draft.js";
import type { DashboardDependencies } from "../server.js";

/** 校验并提取可更新字段 */
function extractUpdate(body: Record<string, unknown>): TableCardUpdate {
  const update: TableCardUpdate = {};
  if (typeof body.summary === "string") update.summary = body.summary;
  if (body.suitableFor !== undefined) update.suitableFor = Array.isArray(body.suitableFor) ? body.suitableFor.map(String) : [String(body.suitableFor)];
  if (body.boundaries !== undefined) update.boundaries = Array.isArray(body.boundaries) ? body.boundaries.map(String) : [String(body.boundaries)];
  if (body.whenToUse !== undefined) update.whenToUse = Array.isArray(body.whenToUse) ? body.whenToUse.map(String) : [String(body.whenToUse)];
  if (body.tags !== undefined) update.tags = Array.isArray(body.tags) ? body.tags.map(String) : [String(body.tags)];
  if (body.status === "user-confirmed" || body.status === "ai-drafted") {
    update.status = body.status;
  }
  return update;
}

export function createTableCardsRouter(deps: DashboardDependencies): Router {
  const router = Router();
  const store = new TableCardStore(deps.projectDir);

  /** 全部卡片 */
  router.get("/api/table-cards", (_req: Request, res: Response) => {
    try {
      const { cards, revision } = store.list();
      res.json({ data: { cards, revision }, meta: { requestId: randomUUID() } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "获取表卡片失败";
      res.status(500).json({ error: { code: "TABLE_CARDS_READ_ERROR", message: msg }, meta: { requestId: randomUUID() } });
    }
  });

  /** 单张卡片 */
  router.get("/api/table-cards/:table", (req: Request, res: Response) => {
    const table = req.params.table as string;
    if (!/^[\w.-]+$/.test(table)) {
      res.status(400).json({ error: { code: "INVALID_TABLE_NAME", message: "无效的表名" }, meta: { requestId: randomUUID() } });
      return;
    }

    try {
      const card = store.get(table);
      if (!card) {
        res.status(404).json({ error: { code: "CARD_NOT_FOUND", message: `表 "${table}" 尚无卡片` }, meta: { requestId: randomUUID() } });
        return;
      }
      const { revision } = store.list();
      res.json({ data: { card, revision }, meta: { requestId: randomUUID() } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "获取表卡片失败";
      res.status(500).json({ error: { code: "TABLE_CARDS_READ_ERROR", message: msg }, meta: { requestId: randomUUID() } });
    }
  });

  /** 用户编辑 / 确认 */
  router.put("/api/table-cards/:table", (req: Request, res: Response) => {
    const table = req.params.table as string;
    if (!/^[\w.-]+$/.test(table)) {
      res.status(400).json({ error: { code: "INVALID_TABLE_NAME", message: "无效的表名" }, meta: { requestId: randomUUID() } });
      return;
    }

    const expectedRevision = typeof req.body?.expectedRevision === "number" ? req.body.expectedRevision : -1;

    try {
      const result = store.put(table, extractUpdate(req.body ?? {}), expectedRevision);
      const card = store.get(table);
      res.json({ data: { card, ...result }, meta: { requestId: randomUUID() } });
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        res.status(409).json({
          error: {
            code: err.code,
            message: err.message,
            currentRevision: store.list().revision,
          },
          meta: { requestId: randomUUID() },
        });
        return;
      }
      const msg = err instanceof Error ? err.message : "保存表卡片失败";
      res.status(500).json({ error: { code: "TABLE_CARD_UPDATE_ERROR", message: msg }, meta: { requestId: randomUUID() } });
    }
  });

  /** AI 起草 */
  router.post("/api/table-cards/:table/draft", async (req: Request, res: Response) => {
    const table = req.params.table as string;
    if (!/^[\w.-]+$/.test(table)) {
      res.status(400).json({ error: { code: "INVALID_TABLE_NAME", message: "无效的表名" }, meta: { requestId: randomUUID() } });
      return;
    }

    // 风格对齐字典推断路由：依赖缺失 → 503
    if (!deps.engine) {
      res.status(503).json({ error: { code: "ENGINE_UNAVAILABLE", message: "DuckDB 引擎不可用，请先在 TUI 中加载数据集" }, meta: { requestId: randomUUID() } });
      return;
    }
    if (!deps.callLLM) {
      res.status(503).json({ error: { code: "LLM_UNAVAILABLE", message: "未配置 AI 模型，起草功能不可用" }, meta: { requestId: randomUUID() } });
      return;
    }

    // 表必须真实存在（schema 可读）
    try {
      await deps.engine.getSchema(table);
    } catch {
      res.status(404).json({ error: { code: "TABLE_NOT_FOUND", message: `表 "${table}" 在当前数据集中不存在` }, meta: { requestId: randomUUID() } });
      return;
    }

    try {
      const recentQueries = deps.queryMemory?.getMemory()?.entries ?? [];
      const card = await draftCardForTable(
        { store, engine: deps.engine, callLLM: deps.callLLM, recentQueries },
        table,
      );
      store.saveDraft(card);
      const { revision } = store.list();
      res.json({ data: { card, revision }, meta: { requestId: randomUUID() } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI 起草失败";
      res.status(500).json({ error: { code: "TABLE_CARD_DRAFT_ERROR", message: msg }, meta: { requestId: randomUUID() } });
    }
  });

  return router;
}
