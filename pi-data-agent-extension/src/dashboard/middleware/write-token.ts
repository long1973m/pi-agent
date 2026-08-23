/**
 * Middleware: 写令牌验证
 *
 * 所有 POST、PATCH、DELETE、PUT 请求必须携带有效的写令牌。
 *
 * 令牌由 lifecycle.ts 在启动时从 <projectDir>/dashboard-token 加载（缺失或非法才生成），
 * 持久化是为了服务重启后旧浏览器标签页持有的令牌不失效。
 * 安全边界：该令牌是本机 CSRF 盾，不是访问凭证——服务只绑定 127.0.0.1，
 * GET /api/config 本来就会向本地页面下发令牌，持久化（0600 权限）不弱化安全模型。
 */

import type { Request, Response, NextFunction } from "express";
import { WRITE_TOKEN_HEADER } from "../config.js";
import { timingSafeEqual } from "node:crypto";

/** 存储 { requestId → writeToken } 的映射，由 server.ts 设置 */
const tokenStore = new Map<string, string>();

/** 设置当前服务的写令牌 */
export function setWriteToken(token: string): void {
  tokenStore.set("current", token);
}

/** 获取当前写令牌 */
export function getWriteToken(): string {
  return tokenStore.get("current") ?? "";
}

/** 写令牌验证中间件 */
export function writeTokenGuard(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  const writeMethods = new Set(["POST", "PATCH", "DELETE", "PUT"]);

  if (!writeMethods.has(method)) {
    next();
    return;
  }

  const token = req.headers[WRITE_TOKEN_HEADER.toLowerCase()] as string
    ?? req.headers["authorization"]?.replace(/^Bearer\s+/i, "");

  const expected = getWriteToken();

  // 常量时间比较，防止时序攻击
  if (!token || !constantTimeEquals(token, expected)) {
    res.status(403).json({
      error: {
        code: "INVALID_WRITE_TOKEN",
        message: "写令牌无效或缺失",
      },
      meta: { requestId: "" },
    });
    return;
  }

  next();
}

/** 常量时间字符串比较 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
