/**
 * Dashboard — 报告路由
 *
 * GET /api/reports?page=1&size=20&query=&dataset=&type=analysis|session
 * GET /api/reports/:reportId
 * GET /api/reports/:reportId/content
 * GET /api/reports/:reportId/evidence-summary
 * POST /api/reports/:sessionId/generate-analysis (501 — 渐进式)
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeTokenGuard } from "../middleware/write-token.js";
import { ReportIndexService } from "../services/report-index.js";
import type { DashboardDependencies } from "../server.js";

export function createReportsRouter(deps: DashboardDependencies): Router {
  const router = Router();
  const service = new ReportIndexService(deps.projectDir);

  /** 报告列表（分页 + 筛选 + 类型过滤） */
  router.get("/api/reports", (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string, 10) || undefined;
      const size = parseInt(req.query.size as string, 10) || undefined;
      const query = req.query.query as string | undefined;
      const dataset = req.query.dataset as string | undefined;
      const type = req.query.type as string | undefined;

      // 如果指定了 type，使用 listByType 返回（无分页），否则走通用 list
      if (type) {
        const validTypes = ["session", "analysis"];
        if (!validTypes.includes(type)) {
          res.status(400).json({
            error: {
              code: "INVALID_TYPE_PARAM",
              message: `type 参数只允许 ${validTypes.join(" | ")}`,
            },
            meta: { requestId: randomUUID() },
          });
          return;
        }
        const typedReports = service.listByType(type as "session" | "analysis");
        // 在已按类型过滤的基础上，再做 query/dataset 过滤和分页
        let filtered = typedReports;
        const queryLower = (query ?? "").toLowerCase().trim();
        const datasetLower = (dataset ?? "").toLowerCase().trim();
        if (queryLower) {
          filtered = filtered.filter(
            (r) =>
              r.title.toLowerCase().includes(queryLower) ||
              r.summary.toLowerCase().includes(queryLower)
          );
        }
        if (datasetLower) {
          filtered = filtered.filter((r) =>
            r.datasets.some((d) => d.toLowerCase().includes(datasetLower))
          );
        }
        const p = Math.max(1, page ?? 1);
        const s = Math.min(100, Math.max(1, size ?? 20));
        const total = filtered.length;
        const totalPages = Math.max(1, Math.ceil(total / s));
        const start = (p - 1) * s;
        const items = filtered.slice(start, start + s);

        res.json({
          data: { items, total, page: p, size: s, totalPages },
          meta: { requestId: randomUUID() },
        });
      } else {
        const result = service.list({ page, size, query, dataset });
        res.json({
          data: result,
          meta: { requestId: randomUUID() },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "获取报告列表失败";
      res.status(500).json({
        error: { code: "REPORTS_LIST_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  /** 单个报告详情 */
  router.get("/api/reports/:reportId", (req: Request, res: Response) => {
    const reportId = req.params.reportId as string;

    // 安全校验：reportId 只允许字母数字和连字符
    if (!/^[\w-]+$/.test(reportId)) {
      res.status(400).json({
        error: { code: "INVALID_REPORT_ID", message: "无效的报告 ID" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    const report = service.get(reportId);
    if (!report) {
      res.status(404).json({
        error: { code: "REPORT_NOT_FOUND", message: "报告不存在" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    res.json({
      data: report,
      meta: { requestId: randomUUID() },
    });
  });

  /** 报告 HTML 内容 */
  router.get("/api/reports/:reportId/content", (req: Request, res: Response) => {
    const reportId = req.params.reportId as string;

    if (!/^[\w-]+$/.test(reportId)) {
      res.status(400).json({
        error: { code: "INVALID_REPORT_ID", message: "无效的报告 ID" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    const content = service.getContent(reportId);
    if (content === null) {
      res.status(404).json({
        error: { code: "REPORT_CONTENT_NOT_FOUND", message: "报告内容不存在或已损坏" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    res.json({
      data: { content },
      meta: { requestId: randomUUID() },
    });
  });

  /** 分析报告证据摘要 */
  router.get("/api/reports/:reportId/evidence-summary", (req: Request, res: Response) => {
    const reportId = req.params.reportId as string;

    if (!/^[\w-]+$/.test(reportId)) {
      res.status(400).json({
        error: { code: "INVALID_REPORT_ID", message: "无效的报告 ID" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    // 读取 evidence JSON
    const evidencePath = join(deps.projectDir, "reports", "evidence", `${reportId}.json`);
    if (!existsSync(evidencePath)) {
      res.status(404).json({
        error: { code: "EVIDENCE_NOT_FOUND", message: "该报告的证据文件不存在" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    try {
      const raw = readFileSync(evidencePath, "utf-8");
      const evidence = JSON.parse(raw);

      // 提取摘要信息
      const summary = {
        reportId,
        coverage: evidence.coverage ?? 0,
        findingsCount: Array.isArray(evidence.findings) ? evidence.findings.length : 0,
        queriesCount: Array.isArray(evidence.queries) ? evidence.queries.length : 0,
        chartsCount: Array.isArray(evidence.charts) ? evidence.charts.length : 0,
        caliberCount: Array.isArray(evidence.calibers) ? evidence.calibers.length : 0,
        timestamp: evidence.timestamp ?? null,
      };

      res.json({
        data: summary,
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      res.status(500).json({
        error: {
          code: "EVIDENCE_PARSE_ERROR",
          message: `证据文件解析失败: ${err instanceof Error ? err.message : String(err)}`,
        },
        meta: { requestId: randomUUID() },
      });
    }
  });

  /** 生成正式分析报告（渐进式：Dashboard 无法访问 Agent sessionManager） */
  router.post(
    "/api/reports/:sessionId/generate-analysis",
    writeTokenGuard,
    async (req: Request, res: Response) => {
      // 501 — 当前 Dashboard 无 Agent-Extension 通信机制
      // 用户应在 Agent 中使用 /report 命令触发分析报告生成
      res.status(501).json({
        error: {
          code: "NOT_IMPLEMENTED",
          message:
            "Dashboard 暂不支持直接生成分析报告。请在 Agent 中使用 /report 命令（支持 /report executive 或 /report detailed）。",
        },
        meta: { requestId: randomUUID() },
      });
    }
  );

  return router;
}
