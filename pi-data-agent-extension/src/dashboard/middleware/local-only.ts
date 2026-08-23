/**
 * Middleware: 限制只接受来自 localhost 的请求
 *
 * 安全策略：仅使用 socket.remoteAddress 判定来源。
 * 不信任 X-Forwarded-For / X-Real-IP 等代理头（可伪造）。
 */

import type { Request, Response, NextFunction } from "express";

const LOCAL_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

export function localOnly(req: Request, res: Response, next: NextFunction): void {
  // 只信任直连的 remoteAddress，不信任代理头
  const ip = req.socket.remoteAddress ?? "";
  const normalizedIp = ip.replace(/^::ffff:/, "");

  if (!LOCAL_ADDRESSES.has(normalizedIp) && normalizedIp !== "localhost") {
    res.status(403).json({
      error: {
        code: "FORBIDDEN_REMOTE",
        message: "Dashboard 只允许本地访问",
      },
      meta: { requestId: "" },
    });
    return;
  }
  next();
}
