/**
 * Dashboard Health 路由
 *
 * GET /api/health — 健康检查
 * GET /api/config — 前端配置（非敏感）
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";

export function createHealthRouter(writeToken: string): Router {
  const router = Router();

  /** 健康检查 */
  router.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      data: {
        status: "ok",
        timestamp: new Date().toISOString(),
      },
      meta: { requestId: "" },
    });
  });

  /** 前端配置（不返回敏感信息） */
  router.get("/api/config", (_req: Request, res: Response) => {
    res.json({
      data: {
        writeToken, // 前端需要此 token 来发送写请求
        theme: "catppuccin-mocha",
      },
      meta: { requestId: randomUUID() },
    });
  });

  return router;
}
