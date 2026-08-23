/**
 * v0.10 A-2 — 上传响应含数据体检卡（dataProfile）验收测试（vitest）
 *
 * 覆盖:
 * - UP1: 成功分支 — 上传 CSV → loaded.ok=true 且 loaded.dataProfile 为结构化
 *        TableProfile（行×列 / 缺失率 / 候选维度 / 时间跨度 / 建议问句 ≤3 条）
 * - UP2: 降级分支 — profileTable 失败（SUMMARIZE 报错）→ dataProfile 字段静默省略，
 *        上传与自动建表仍成功
 *
 * 测试约束：独立临时目录（mkdtempSync 隔离，不写共享 session.duckdb），
 * 不依赖网络与真实 LLM。setup 模式参考 upload-autoload.test.ts。
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Request, Response } from "express";

import { createUploadRouter, type UploadDeps } from "../dashboard/routes/upload.js";
import { loadConfig } from "../config.js";
import { DuckDBEngine } from "../engine/duckdb.js";

let engine: DuckDBEngine | null = null;
let tmpDir: string | null = null;

/**
 * 构造隔离配置：DEFAULTS 中的路径字段是模块加载时基于 process.cwd() 的绝对路径，
 * 仅覆盖 cwd 不会重定向它们，必须显式覆盖全部路径，避免测试写入共享 session.duckdb。
 */
function makeIsolatedConfig(dir: string) {
  return loadConfig({
    cwd: dir,
    allowedPaths: [dir],
    dbPath: join(dir, ".pi-data-agent", "session.duckdb"),
    projectConfigDir: join(dir, ".pi-data-agent"),
    outputDir: join(dir, ".pi-data-agent", "output"),
    uploadsDir: join(dir, ".pi-data-agent", "uploads"),
  });
}

async function setup(depsOverride: Partial<UploadDeps> = {}): Promise<{ router: ReturnType<typeof createUploadRouter>; uploadsDir: string }> {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-upload-profile-test-"));
  const config = makeIsolatedConfig(tmpDir);
  engine = new DuckDBEngine({
    dbPath: config.dbPath,
    previewLimit: config.previewLimit,
    outputDir: config.outputDir,
  });
  await engine.init();
  const uploadsDir = join(tmpDir, "uploads");
  // 上传路由假定目录已存在（生产环境由 ensureUploadsDir 在 session_start 创建）
  mkdirSync(uploadsDir, { recursive: true });

  const dictStub = {
    hasDictionary: () => false,
    ensureDictionary: async () => ({}),
    refreshFingerprint: async () => undefined,
  };

  const router = createUploadRouter({
    uploadsDir,
    engine,
    dataDictionary: dictStub as never,
    ...depsOverride,
  });
  return { router, uploadsDir };
}

/** 构造 mock req/res 并直接调用 router（沿用 upload-autoload.test.ts 的 mock 风格） */
async function invokeRouter(
  router: ReturnType<typeof createUploadRouter>,
  opts: { method: string; path: string; body?: unknown }
): Promise<{ statusCode: number; body: any }> {
  const req = {
    method: opts.method,
    url: opts.path,
    originalUrl: opts.path,
    path: opts.path,
    headers: { "content-type": "application/json" } as Record<string, unknown>,
    params: {},
    query: {},
    body: opts.body,
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as Request;

  let statusCode = 0;
  let resBody: unknown;
  let resolveJson: (() => void) | null = null;
  const jsonDone = new Promise<void>((resolve) => { resolveJson = resolve; });

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: unknown) {
      resBody = data;
      statusCode = statusCode || 200;
      resolveJson?.();
      return this;
    },
    setHeader() { return this; },
    type() { return this; },
    send(data: unknown) {
      resBody = data;
      resolveJson?.();
      return this;
    },
  } as unknown as Response;

  const next = () => {
    resolveJson?.(); // 路由未匹配时避免挂起
  };

  router(req, res, next);
  await Promise.race([jsonDone, new Promise((r) => setTimeout(r, 15000))]);
  return { statusCode, body: resBody };
}

afterEach(async () => {
  if (engine) {
    await engine.close();
    engine = null;
  }
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("上传响应含 dataProfile（v0.10 A-2）", () => {
  it("UP1: 成功分支 — loaded.dataProfile 为结构化体检卡", async () => {
    const { router } = await setup();
    const csv = [
      "order_id,city,amount,order_date",
      "1,北京,100.5,2025-01-01",
      "2,上海,88.0,2025-01-02",
      "3,北京,120.0,2025-01-03",
      "4,广州,60.5,2025-01-04",
      "",
    ].join("\n");
    const { statusCode, body } = await invokeRouter(router, {
      method: "POST",
      path: "/api/upload",
      body: { filename: "orders.csv", content: Buffer.from(csv).toString("base64") },
    });

    expect(statusCode).toBe(200);
    const loaded = body?.data?.loaded;
    expect(loaded.ok).toBe(true);
    expect(loaded.tableName).toBe("orders");
    expect(loaded.rowCount).toBe(4);

    // 结构化体检卡随响应下发（可 JSON 序列化）
    const profile = loaded.dataProfile;
    expect(profile).toBeTruthy();
    expect(profile.tableName).toBe("orders");
    expect(profile.rowCount).toBe(4);
    expect(profile.columnCount).toBe(4);
    expect(profile.degraded).toBe(false);

    // 结构化数组字段齐全
    expect(Array.isArray(profile.missingColumns)).toBe(true);
    expect(Array.isArray(profile.severeMissingColumns)).toBe(true);
    expect(Array.isArray(profile.lowCardinalityColumns)).toBe(true);
    expect(Array.isArray(profile.primaryKeySuspicion)).toBe(true);

    // city 是低基数候选维度；order_date 识别出时间跨度
    expect(profile.lowCardinalityColumns.some((c: { name: string }) => c.name === "city")).toBe(true);
    expect(profile.timeSpan).toBeTruthy();
    expect(profile.timeSpan.column).toBe("order_date");

    // 建议问句：规则生成、≤3 条，可直接复制提问
    expect(Array.isArray(profile.suggestedQuestions)).toBe(true);
    expect(profile.suggestedQuestions.length).toBeGreaterThan(0);
    expect(profile.suggestedQuestions.length).toBeLessThanOrEqual(3);
    for (const q of profile.suggestedQuestions) {
      expect(typeof q).toBe("string");
      expect(q.length).toBeGreaterThan(0);
    }
  });

  it("UP2: 降级分支 — profileTable 失败时 dataProfile 省略，上传与建表仍成功", async () => {
    const { uploadsDir } = await setup();

    // 代理 engine：仅拦截 profileTable 的第一步 SUMMARIZE 使其抛错，
    // 其余方法（loadTableFast 等，建表所需）原样透传给真实 engine
    const flakyEngine = new Proxy(engine!, {
      get(target, prop) {
        if (prop === "query") {
          return async (sql: string) => {
            if (String(sql).trim().toUpperCase().startsWith("SUMMARIZE")) {
              throw new Error("simulated profile failure");
            }
            return target.query(sql);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as DuckDBEngine;

    const dictStub = {
      hasDictionary: () => false,
      ensureDictionary: async () => ({}),
      refreshFingerprint: async () => undefined,
    };
    const router = createUploadRouter({
      uploadsDir,
      engine: flakyEngine,
      dataDictionary: dictStub as never,
    });

    const csv = "a,b\n1,2\n3,4\n";
    const { statusCode, body } = await invokeRouter(router, {
      method: "POST",
      path: "/api/upload",
      body: { filename: "fallback.csv", content: Buffer.from(csv).toString("base64") },
    });

    // 上传本身成功，自动建表不受画像失败影响
    expect(statusCode).toBe(200);
    const loaded = body?.data?.loaded;
    expect(loaded.ok).toBe(true);
    expect(loaded.tableName).toBe("fallback");
    expect(loaded.rowCount).toBe(2);
    expect(loaded.columnCount).toBe(2);

    // 画像失败 → dataProfile 字段静默省略
    expect(loaded.dataProfile).toBeUndefined();

    // 表确实建好，引擎中立即可查
    const tables = await engine!.getTables();
    expect(tables).toContain("fallback");
  });
});
