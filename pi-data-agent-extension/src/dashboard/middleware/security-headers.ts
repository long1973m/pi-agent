/**
 * Middleware: 安全响应头
 *
 * 设置标准的 HTTP 安全头，防止 MIME 嗅探、点击劫持等攻击。
 */

import type { Request, Response, NextFunction } from "express";

/** 安全响应头中间件 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  // 防止 MIME 类型嗅探
  res.setHeader("X-Content-Type-Options", "nosniff");

  // 防止页面被 iframe 嵌入（点击劫持防护）
  res.setHeader("X-Frame-Options", "DENY");

  // 控制 Referrer 信息泄露
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // 禁用不必要的缓存（API 响应不应被缓存）
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }

  // XSS 保护（虽然现代浏览器已内置，但作为纵深防御保留）
  res.setHeader("X-XSS-Protection", "1; mode=block");

  // HSTS（仅在 HTTPS 下有效，localhost HTTP 下浏览器会忽略）
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

  next();
}
