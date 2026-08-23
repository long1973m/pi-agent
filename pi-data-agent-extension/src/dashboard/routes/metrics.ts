/**
 * Dashboard — 指标定义路由（v0.10 A-6：口径管理 → 指标定义）
 *
 * GET    /api/metrics   → { data: { metrics(活跃定义), legacy(历史口径), revision } }
 * POST   /api/metrics   新建指标定义（name/definition 必填；notes/datasets 选填）
 * PATCH  /api/metrics/:metricId  编辑（legacy 历史口径 → 400 LEGACY_READ_ONLY）
 * DELETE /api/metrics/:metricId  删除/归档（legacy 历史口径 → 400 LEGACY_READ_ONLY）
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { MetricStore, LegacyReadOnlyError } from "../services/metric-store.js";
import type { DashboardDependencies } from "../server.js";
import { RevisionConflictError } from "../services/atomic-store.js";

export function createMetricsRouter(deps: DashboardDependencies): Router {
  const router = Router();
  const store = new MetricStore(deps.projectDir);

  /** 指标列表（活跃定义 + 只读历史口径） */
  router.get("/api/metrics", (req: Request, res: Response) => {
    try {
      const includeArchived = req.query.includeArchived === "true";
      const active = store.list({ includeArchived });
      const legacy = store.listLegacy();

      res.json({
        data: {
          metrics: active.metrics,
          legacy: legacy.legacy,
          revision: active.revision,
        },
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "获取指标列表失败";
      res.status(500).json({ error: { code: "METRICS_LIST_ERROR", message: msg }, meta: { requestId: randomUUID() } });
    }
  });

  /** 新增指标定义 */
  router.post("/api/metrics", (req: Request, res: Response) => {
    const { name, definition, datasets, status, notes, appliedAssumption } = req.body;
    const expectedRevision = req.body.expectedRevision ?? -1;

    if (!name || !definition) {
      res.status(400).json({ error: { code: "INVALID_METRIC", message: "指标名称和计算规则不能为空" }, meta: { requestId: randomUUID() } });
      return;
    }

    try {
      const result = store.create({
        name,
        definition,
        datasets: Array.isArray(datasets) ? datasets.map(String) : [],
        status: status ?? "user-confirmed",
        source: "user" as const,
        notes: typeof notes === "string" ? notes : undefined,
        appliedAssumption,
      }, expectedRevision);

      res.status(201).json({ data: result, meta: { requestId: randomUUID() } });
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        res.status(409).json({ error: { code: err.code, message: err.message }, meta: { requestId: randomUUID() } });
        return;
      }
      const msg = err instanceof Error ? err.message : "创建指标失败";
      res.status(500).json({ error: { code: "METRIC_CREATE_ERROR", message: msg }, meta: { requestId: randomUUID() } });
    }
  });

  /** 更新指标定义 */
  router.patch("/api/metrics/:metricId", (req: Request, res: Response) => {
    const metricId = req.params.metricId as string;
    if (!/^[\w-]+$/.test(metricId)) {
      res.status(400).json({ error: { code: "INVALID_METRIC_ID", message: "无效的指标 ID" }, meta: { requestId: randomUUID() } });
      return;
    }

    const { name, definition, datasets, status, notes, appliedAssumption } = req.body;
    const expectedRevision = req.body.expectedRevision ?? -1;

    try {
      // 只收集调用方明确传入的字段，避免 undefined 覆盖已有值（尤其 notes 置空场景）
      const updates: Parameters<MetricStore["update"]>[1] = {};
      if (name !== undefined) updates.name = name;
      if (definition !== undefined) updates.definition = definition;
      if (datasets !== undefined) {
        updates.datasets = Array.isArray(datasets) ? datasets.map(String) : [String(datasets)];
      }
      if (status !== undefined) updates.status = status;
      if (notes !== undefined) updates.notes = typeof notes === "string" ? notes : String(notes);
      if (appliedAssumption !== undefined) updates.appliedAssumption = appliedAssumption;

      const result = store.update(metricId, updates, expectedRevision);

      res.json({ data: result, meta: { requestId: randomUUID() } });
    } catch (err) {
      if (err instanceof LegacyReadOnlyError) {
        res.status(400).json({ error: { code: err.code, message: err.message }, meta: { requestId: randomUUID() } });
        return;
      }
      if (err instanceof RevisionConflictError) {
        res.status(409).json({ error: { code: err.code, message: err.message }, meta: { requestId: randomUUID() } });
        return;
      }
      const msg = err instanceof Error ? err.message : "更新指标失败";
      res.status(500).json({ error: { code: "METRIC_UPDATE_ERROR", message: msg }, meta: { requestId: randomUUID() } });
    }
  });

  /** 删除指标定义（软删除/归档） */
  router.delete("/api/metrics/:metricId", (req: Request, res: Response) => {
    const metricId = req.params.metricId as string;
    if (!/^[\w-]+$/.test(metricId)) {
      res.status(400).json({ error: { code: "INVALID_METRIC_ID", message: "无效的指标 ID" }, meta: { requestId: randomUUID() } });
      return;
    }

    const expectedRevision = req.body.expectedRevision ?? -1;

    try {
      const result = store.archive(metricId, expectedRevision);
      res.json({ data: result, meta: { requestId: randomUUID() } });
    } catch (err) {
      if (err instanceof LegacyReadOnlyError) {
        res.status(400).json({ error: { code: err.code, message: err.message }, meta: { requestId: randomUUID() } });
        return;
      }
      if (err instanceof RevisionConflictError) {
        res.status(409).json({ error: { code: err.code, message: err.message }, meta: { requestId: randomUUID() } });
        return;
      }
      const msg = err instanceof Error ? err.message : "删除指标失败";
      res.status(500).json({ error: { code: "METRIC_ARCHIVE_ERROR", message: msg }, meta: { requestId: randomUUID() } });
    }
  });

  return router;
}
