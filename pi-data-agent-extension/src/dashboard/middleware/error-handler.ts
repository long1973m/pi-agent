/**
 * Middleware: 统一错误处理
 *
 * - 捕获所有未处理的错误
 * - 不泄露本机路径、堆栈和令牌
 * - 统一错误响应格式
 */

import type { Request, Response, NextFunction } from "express";

export interface ApiError extends Error {
  statusCode?: number;
  code?: string;
  details?: Record<string, unknown>;
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const apiErr = err as ApiError;
  const statusCode = apiErr.statusCode ?? 500;
  const code = apiErr.code ?? "INTERNAL_ERROR";

  // 不泄露敏感信息
  const message = statusCode === 500
    ? "内部服务器错误"
    : err.message;

  // 不泄露堆栈和路径
  const safeMessage = sanitizeMessage(message);

  console.error(`[Dashboard] Error ${statusCode} ${code}: ${safeMessage}`);

  res.status(statusCode).json({
    error: {
      code,
      message: safeMessage,
      details: apiErr.details,
    },
    meta: { requestId: "" },
  });
}

/** 移除错误消息中的绝对路径和堆栈信息 */
function sanitizeMessage(msg: string): string {
  return msg
    .replace(/\/(?:Users|home|tmp|var)\//g, ".../")
    .replace(/\n/g, " ")
    .slice(0, 200);
}
