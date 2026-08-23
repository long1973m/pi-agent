import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import http from "node:http";

import { createDashboardServer } from "../dashboard/server.js";
import { createHostCheck, dashboardAllowedHosts } from "../dashboard/middleware/host-check.js";
import type { Request, Response, NextFunction } from "express";

describe("hostCheck 中间件（v0.11 S-3 防 DNS rebinding）", () => {
  const PORT = 3456;

  /** 构造 mock req/res 并执行中间件，捕获 next / 响应 */
  function runMiddleware(hostHeader: string | undefined, allowedHosts: () => string[]) {
    const headers: Record<string, string> = {};
    if (hostHeader !== undefined) headers.host = hostHeader;
    const req = { headers } as unknown as Request;
    let statusCode = 0;
    let body: any = null;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: any) {
        body = payload;
      },
    } as unknown as Response;
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    createHostCheck(allowedHosts)(req, res, next);
    return { statusCode, body, nextCalled };
  }

  it("本机 Host（127.0.0.1 / localhost / [::1]）放行", () => {
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]) {
      const r = runMiddleware(host, () => dashboardAllowedHosts(PORT));
      expect(r.nextCalled).toBe(true);
      expect(r.statusCode).toBe(0);
    }
  });

  it("Host 比较大小写不敏感", () => {
    const r = runMiddleware(`LOCALHOST:${PORT}`, () => dashboardAllowedHosts(PORT));
    expect(r.nextCalled).toBe(true);
  });

  it("非法域名（DNS rebinding 场景）返回 403 INVALID_HOST", () => {
    for (const host of ["evil.com", `evil.com:${PORT}`]) {
      const r = runMiddleware(host, () => dashboardAllowedHosts(PORT));
      expect(r.nextCalled).toBe(false);
      expect(r.statusCode).toBe(403);
      expect(r.body?.error?.code).toBe("INVALID_HOST");
    }
  });

  it("本机地址但端口不符仍拒绝（防跨端口探测）", () => {
    const r = runMiddleware(`127.0.0.1:${PORT + 1}`, () => dashboardAllowedHosts(PORT));
    expect(r.statusCode).toBe(403);
  });

  it("缺失 Host 头视为畸形请求，返回 403", () => {
    const r = runMiddleware(undefined, () => dashboardAllowedHosts(PORT));
    expect(r.statusCode).toBe(403);
    expect(r.body?.error?.code).toBe("INVALID_HOST");
  });

  it("provider 动态更新白名单后即刻生效（port=0 绑定后才知真实端口）", () => {
    let currentPort = 0; // 模拟挂载时尚未绑定
    const provider = () => dashboardAllowedHosts(currentPort);

    const beforeBind = runMiddleware(`127.0.0.1:${PORT}`, provider);
    expect(beforeBind.statusCode).toBe(403);

    currentPort = PORT; // 模拟 listen 回调后 address() 解析出真实端口
    const afterBind = runMiddleware(`127.0.0.1:${PORT}`, provider);
    expect(afterBind.nextCalled).toBe(true);
  });
});

describe("hostCheck 集成：真实 server（临时端口）正常访问不受影响、伪造 Host 被拒", () => {
  let server: Server | null = null;
  let tmpDir: string | null = null;

  async function startServer(): Promise<number> {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-host-check-test-"));
    const uploadsDir = join(tmpDir, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    server = await createDashboardServer(0, "test-write-token", {
      projectDir: join(tmpDir, ".pi-data-agent"),
      cwd: tmpDir,
      engine: null,
      uploadsDir,
    });
    return (server.address() as AddressInfo).port;
  }

  /** 原始 http 客户端请求，可精确控制 Host 头（fetch 会按 URL 覆写 Host） */
  function rawGet(port: number, hostHeader: string): Promise<{ status?: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/api/health", headers: { host: hostHeader } },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            let body: any = null;
            try {
              body = JSON.parse(data);
            } catch {
              /* 非 JSON 响应体 */
            }
            resolve({ status: res.statusCode, body });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("port=0 启动后，正确 Host 的请求返回 200", async () => {
    const port = await startServer();
    const r = await rawGet(port, `127.0.0.1:${port}`);
    expect(r.status).toBe(200);
    expect(r.body?.data?.status).toBe("ok");
  });

  it("Host: evil.com 返回 403 INVALID_HOST（spec §5.3 验收样本）", async () => {
    const port = await startServer();
    const r = await rawGet(port, "evil.com");
    expect(r.status).toBe(403);
    expect(r.body?.error?.code).toBe("INVALID_HOST");
  });

  afterAll(async () => {
    if (server) {
      (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });
});
