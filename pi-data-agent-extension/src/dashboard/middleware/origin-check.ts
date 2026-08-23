/**
 * Middleware: Origin + Content-Type 校验
 *
 * - 所有请求检查 Origin（写请求必须来自合法本地 Origin）
 * - 写请求必须携带 Content-Type: application/json
 * - 防止跨站请求伪造
 */

import type { Request, Response, NextFunction } from "express";

const ALLOWED_ORIGINS: ReadonlyArray<string | RegExp> = [
  "http://127.0.0.1",
  "http://localhost",
  /^http:\/\/127\.0\.0\.1:\d+$/,
  /^http:\/\/localhost:\d+$/,
];

const JSON_CONTENT_TYPE = "application/json";

export function originCheck(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin as string | undefined;

  // 所有请求都添加 CORS 头（仅限合法 Origin）
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Write-Token");
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  // 处理预检请求
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  // 写请求安全检查
  const method = req.method.toUpperCase();
  const writeMethods = new Set(["POST", "PATCH", "DELETE", "PUT"]);
  if (writeMethods.has(method)) {
    // 1. Origin 校验
    if (!origin || !isAllowedOrigin(origin)) {
      res.status(403).json({
        error: {
          code: "INVALID_ORIGIN",
          message: "请求来源不合法",
        },
        meta: { requestId: "" },
      });
      return;
    }

    // 2. Content-Type 校验（写请求必须是 JSON）
    const contentType = req.headers["content-type"] as string | undefined;
    if (!contentType || !contentType.startsWith(JSON_CONTENT_TYPE)) {
      res.status(400).json({
        error: {
          code: "INVALID_CONTENT_TYPE",
          message: "写请求必须使用 application/json 内容类型",
        },
        meta: { requestId: "" },
      });
      return;
    }
  }

  next();
}

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.some((allowed) => {
    if (typeof allowed === "string") {
      return origin === allowed || origin.startsWith(allowed + ":");
    }
    return allowed.test(origin);
  });
}
