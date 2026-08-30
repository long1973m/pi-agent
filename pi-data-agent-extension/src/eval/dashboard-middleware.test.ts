/**
 * T-3 — Dashboard 安全中间件直接单测（vitest）
 *
 * 覆盖:
 * - M1 origin-check: 合法 Origin 放行 + CORS 头、写请求缺/非法 Origin 403、
 *   非 JSON Content-Type 400、OPTIONS 预检 204
 * - M2 rate-limiter: 健康检查不限流、首请求带限额头、超限 429
 * - M3 security-headers: 标准安全头、/api/ 路径禁缓存
 * - M4 error-handler: 500 不泄露内部信息、自定义 statusCode/code 透传、消息脱敏
 */

import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

import { originCheck } from "../dashboard/middleware/origin-check.js";
import { rateLimiter } from "../dashboard/middleware/rate-limiter.js";
import { securityHeaders } from "../dashboard/middleware/security-headers.js";
import { errorHandler } from "../dashboard/middleware/error-handler.js";

/** 最小 Response 桩 */
function makeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: undefined as unknown,
    ended: false,
    setHeader(k: string, v: unknown) {
      res.headers[k.toLowerCase()] = v;
    },
    getHeader(k: string) {
      return res.headers[k.toLowerCase()];
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    end() {
      res.ended = true;
    },
  };
  return res as unknown as Response & Record<string, unknown>;
}

/** 最小 Request 桩 */
function makeReq(over: Partial<Record<string, unknown>> = {}) {
  return {
    method: "GET",
    path: "/api/datasets",
    headers: {} as Record<string, string>,
    socket: { remoteAddress: "127.0.0.1" },
    ...over,
  } as unknown as Request;
}

describe("origin-check（T-3）", () => {
  it("M1-a: GET 无 Origin 直接放行，不设 CORS 头", () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    originCheck(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.getHeader("access-control-allow-origin")).toBeUndefined();
  });

  it("M1-b: GET 带合法 localhost Origin → 放行并设置 CORS 头", () => {
    const req = makeReq({ headers: { origin: "http://localhost:5173" } });
    const res = makeRes();
    const next = vi.fn();

    originCheck(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.getHeader("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(res.getHeader("access-control-allow-methods")).toContain("POST");
  });

  it("M1-c: OPTIONS 预检返回 204 且不调用 next", () => {
    const req = makeReq({ method: "OPTIONS", headers: { origin: "http://localhost:5173" } });
    const res = makeRes();
    const next = vi.fn();

    originCheck(req, res, next as NextFunction);

    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("M1-d: POST 缺 Origin → 403 INVALID_ORIGIN", () => {
    const req = makeReq({ method: "POST" });
    const res = makeRes();
    const next = vi.fn();

    originCheck(req, res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("INVALID_ORIGIN");
  });

  it("M1-e: POST 非法 Origin（跨站）→ 403", () => {
    const req = makeReq({
      method: "POST",
      headers: { origin: "http://evil.example.com" },
    });
    const res = makeRes();
    const next = vi.fn();

    originCheck(req, res, next as NextFunction);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("M1-f: POST 合法 Origin 但非 JSON Content-Type → 400 INVALID_CONTENT_TYPE", () => {
    const req = makeReq({
      method: "POST",
      headers: { origin: "http://127.0.0.1:3210", "content-type": "text/plain" },
    });
    const res = makeRes();
    const next = vi.fn();

    originCheck(req, res, next as NextFunction);

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("INVALID_CONTENT_TYPE");
  });

  it("M1-g: POST 合法 Origin + JSON Content-Type → 放行", () => {
    const req = makeReq({
      method: "POST",
      headers: { origin: "http://127.0.0.1:3210", "content-type": "application/json" },
    });
    const res = makeRes();
    const next = vi.fn();

    originCheck(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("rate-limiter（T-3）", () => {
  it("M2-a: 健康检查端点不限流", () => {
    const req = makeReq({ path: "/api/health", socket: { remoteAddress: "10.9.9.1" } });
    const res = makeRes();
    const next = vi.fn();

    rateLimiter(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.getHeader("x-ratelimit-limit")).toBeUndefined();
  });

  it("M2-b: 首请求放行并携带限额响应头", () => {
    const req = makeReq({ socket: { remoteAddress: "10.9.9.2" } });
    const res = makeRes();
    const next = vi.fn();

    rateLimiter(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.getHeader("x-ratelimit-limit")).toBe("60");
    expect(res.getHeader("x-ratelimit-remaining")).toBe("59");
  });

  it("M2-c: 同一 IP 超过每分钟 60 次 → 第 61 次返回 429", () => {
    const ip = "10.9.9.3";
    let lastRes: ReturnType<typeof makeRes> | null = null;

    for (let i = 0; i < 61; i++) {
      const res = makeRes();
      rateLimiter(makeReq({ socket: { remoteAddress: ip } }), res, vi.fn() as NextFunction);
      lastRes = res;
    }

    expect(lastRes!.statusCode).toBe(429);
    expect((lastRes!.body as { error: { code: string } }).error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(lastRes!.getHeader("x-ratelimit-remaining")).toBe("0");
  });
});

describe("security-headers（T-3）", () => {
  it("M3-a: 所有响应携带标准安全头", () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    securityHeaders(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.getHeader("x-content-type-options")).toBe("nosniff");
    expect(res.getHeader("x-frame-options")).toBe("DENY");
    expect(res.getHeader("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.getHeader("x-xss-protection")).toBe("1; mode=block");
    expect(res.getHeader("strict-transport-security")).toContain("max-age=31536000");
  });

  it("M3-b: /api/ 路径禁缓存，非 API 路径不设 Cache-Control", () => {
    const apiRes = makeRes();
    securityHeaders(makeReq({ path: "/api/metrics" }), apiRes, vi.fn() as NextFunction);
    expect(apiRes.getHeader("cache-control")).toContain("no-store");

    const pageRes = makeRes();
    securityHeaders(makeReq({ path: "/reports" }), pageRes, vi.fn() as NextFunction);
    expect(pageRes.getHeader("cache-control")).toBeUndefined();
  });
});

describe("error-handler（T-3）", () => {
  it("M4-a: 未分类错误 → 500 INTERNAL_ERROR，不泄露原始消息/堆栈", () => {
    const err = new Error("secret detail: /Users/mare/secret/db.sqlite");
    const res = makeRes();

    errorHandler(err, makeReq(), res, vi.fn() as NextFunction);

    expect(res.statusCode).toBe(500);
    const body = res.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("内部服务器错误");
    expect(body.error.message).not.toContain("secret");
  });

  it("M4-b: 带 statusCode/code 的 ApiError → 透传状态码与消息", () => {
    const err = Object.assign(new Error("数据集不存在"), {
      statusCode: 404,
      code: "DATASET_NOT_FOUND",
    });
    const res = makeRes();

    errorHandler(err, makeReq(), res, vi.fn() as NextFunction);

    expect(res.statusCode).toBe(404);
    const body = res.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("DATASET_NOT_FOUND");
    expect(body.error.message).toBe("数据集不存在");
  });

  it("M4-c: 错误消息中的绝对路径被脱敏，details 保留", () => {
    const err = Object.assign(new Error("cannot read /Users/mare/data/x.csv"), {
      statusCode: 400,
      code: "READ_FAIL",
      details: { datasetId: "d1" },
    });
    const res = makeRes();

    errorHandler(err, makeReq(), res, vi.fn() as NextFunction);

    const body = res.body as { error: { message: string; details?: unknown } };
    expect(body.error.message).toContain(".../");
    expect(body.error.message).not.toContain("/Users/mare");
    expect(body.error.details).toEqual({ datasetId: "d1" });
  });
});
