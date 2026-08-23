/**
 * Middleware: Host 头校验（v0.11 S-3 防 DNS rebinding）
 *
 * 背景：
 * - localOnly 只看 socket.remoteAddress——DNS rebinding 场景下攻击域名解析到
 *   127.0.0.1，remoteAddress 恰好合法；
 * - origin-check 只校验写请求的 Origin，GET 接口（reports / datasets preview 等）
 *   可被 rebinding 页面直接读取。
 *
 * 本中间件对所有请求生效：Host 必须为本机地址 + 当前端口，否则 403。
 * 缺失 Host 头同样拒绝（HTTP/1.1 规范要求，缺失即畸形请求）。
 */

import type { Request, Response, NextFunction } from "express";

/** 根据监听端口构造允许的 Host 列表 */
export function dashboardAllowedHosts(port: number): string[] {
  return [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ];
}

/**
 * 创建 Host 校验中间件；getAllowedHosts 在每次请求时调用并返回形如
 * ["127.0.0.1:3456", ...] 的白名单。
 *
 * 用 provider 而非静态数组的原因：测试与开发场景用 port 0 让系统分配临时端口，
 * 中间件挂载时尚不知道真实端口，只能在 listen 之后从 address() 动态取。
 */
export function createHostCheck(getAllowedHosts: () => ReadonlyArray<string>) {
  return function hostCheck(req: Request, res: Response, next: NextFunction): void {
    const allowed = new Set(getAllowedHosts().map((h) => h.toLowerCase()));
    const host = (req.headers.host ?? "").trim().toLowerCase();
    if (host.length > 0 && allowed.has(host)) {
      next();
      return;
    }
    res.status(403).json({
      error: {
        code: "INVALID_HOST",
        message: "Dashboard 只允许通过本机地址访问",
      },
      meta: { requestId: "" },
    });
  };
}
