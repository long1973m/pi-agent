/**
 * Middleware: 请求频率限制
 *
 * 基于 IP 的简单滑动窗口限流。
 * 默认每分钟 60 次请求，超过返回 429。
 */

import type { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/** 每分钟最大请求数 */
const MAX_REQUESTS_PER_MINUTE = 60;

/** 滑动窗口大小（毫秒） */
const WINDOW_MS = 60_000;

/** 清理间隔（毫秒） */
const CLEANUP_INTERVAL_MS = 5 * 60_000;

const store = new Map<string, RateLimitEntry>();

/** 上次清理时间 */
let lastCleanup = Date.now();

/** 请求频率限制中间件 */
export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");

  // 健康检查端点不限流
  if (req.path === "/api/health" || req.path === "/health") {
    next();
    return;
  }

  const now = Date.now();

  // 定期清理过期条目
  if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
    for (const [key, entry] of store) {
      if (now - entry.windowStart > WINDOW_MS) {
        store.delete(key);
      }
    }
    lastCleanup = now;
  }

  const entry = store.get(ip);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    // 新窗口
    store.set(ip, { count: 1, windowStart: now });
    setRateLimitHeaders(res, 1, MAX_REQUESTS_PER_MINUTE, now + WINDOW_MS);
    next();
    return;
  }

  entry.count++;

  if (entry.count > MAX_REQUESTS_PER_MINUTE) {
    const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
    setRateLimitHeaders(res, entry.count, MAX_REQUESTS_PER_MINUTE, entry.windowStart + WINDOW_MS);
    res.status(429).json({
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: `请求过于频繁，请在 ${retryAfter} 秒后重试`,
      },
      meta: { requestId: "" },
    });
    return;
  }

  setRateLimitHeaders(res, entry.count, MAX_REQUESTS_PER_MINUTE, entry.windowStart + WINDOW_MS);
  next();
}

/** 设置 Rate Limit 相关响应头 */
function setRateLimitHeaders(
  res: Response,
  current: number,
  limit: number,
  resetAt: number,
): void {
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limit - current)));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
}
