/**
 * Dashboard — 图表路由
 *
 * GET /api/charts?page=1&size=24&reportId=&dataset=
 * GET /api/charts/:chartId
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { ChartIndexService } from "../services/chart-index.js";
import type { DashboardDependencies } from "../server.js";

export function createChartsRouter(deps: DashboardDependencies): Router {
  const router = Router();
  const service = new ChartIndexService(deps.projectDir);

  router.get("/api/charts", (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string, 10) || undefined;
      const size = parseInt(req.query.size as string, 10) || undefined;
      const reportId = req.query.reportId as string | undefined;
      const dataset = req.query.dataset as string | undefined;

      const result = service.list({ page, size, reportId, dataset });
      res.json({ data: result, meta: { requestId: randomUUID() } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "获取图表列表失败";
      res.status(500).json({ error: { code: "CHARTS_LIST_ERROR", message: msg }, meta: { requestId: randomUUID() } });
    }
  });

  router.get("/api/charts/:chartId", (req: Request, res: Response) => {
    const chartId = req.params.chartId as string;
    if (!/^[\w-]+$/.test(chartId)) {
      res.status(400).json({ error: { code: "INVALID_CHART_ID", message: "无效的图表 ID" }, meta: { requestId: randomUUID() } });
      return;
    }

    const chart = service.get(chartId);
    if (!chart) {
      res.status(404).json({ error: { code: "CHART_NOT_FOUND", message: "图表不存在" }, meta: { requestId: randomUUID() } });
      return;
    }

    res.json({ data: chart, meta: { requestId: randomUUID() } });
  });

  return router;
}
