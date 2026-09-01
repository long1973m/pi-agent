/**
 * Dashboard — 连接路由（v0.12 M-8）
 *
 * GET /api/connections — 活跃远程连接 + 远程白名单（只读，无需写令牌）
 *
 * 安全边界：连接摘要不含凭据（RemoteAttachResult 本就无凭据字段）；
 * dbAllowedHosts 是用户自配置的白名单，非敏感信息。
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../../config.js";
import { getActiveRemoteConnections } from "../../engine/remote-dialect.js";

export function createConnectionsRouter(cwd: string): Router {
  const router = Router();

  router.get("/api/connections", (_req: Request, res: Response) => {
    try {
      const config = loadConfig({ cwd });
      res.json({
        data: {
          connections: getActiveRemoteConnections(),
          dbAllowedHosts: config.dbAllowedHosts,
          dbQueryTimeoutMs: config.dbQueryTimeoutMs,
        },
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      res.status(500).json({
        error: { code: "CONNECTIONS_READ_FAIL", message: err instanceof Error ? err.message : String(err) },
        meta: { requestId: randomUUID() },
      });
    }
  });

  return router;
}
