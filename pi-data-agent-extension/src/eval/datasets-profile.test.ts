/**
 * v0.10.2 — 数据体检接口常驻化验收测试（vitest）
 *
 * 覆盖:
 * - PF1: GET /api/datasets/:table/profile 返回结构化 TableProfile
 *   （rowCount / columnCount / suggestedQuestions / missingColumns）
 * - PF2: 未知表 → 404 TABLE_NOT_FOUND
 * - PF3: 非法表名 → 400 INVALID_TABLE_NAME
 * - PF4: engine 为 null → 503 ENGINE_UNAVAILABLE
 *
 * 测试约束：独立临时目录（不写共享 session.duckdb），不依赖网络与真实 LLM。
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Request, Response } from "express";

import { createDatasetsRouter } from "../dashboard/routes/datasets.js";
import { loadConfig } from "../config.js";
import { DuckDBEngine } from "../engine/duckdb.js";

let engine: DuckDBEngine | null = null;
let tmpDir: string | null = null;

/** 构造隔离配置：显式覆盖全部路径字段，避免写入共享 session.duckdb */
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

async function setup(): Promise<ReturnType<typeof createDatasetsRouter>> {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-ds-profile-test-"));
  const config = makeIsolatedConfig(tmpDir);
  engine = new DuckDBEngine({
    dbPath: config.dbPath,
    previewLimit: config.previewLimit,
    outputDir: config.outputDir,
  });
  await engine.init();
  return createDatasetsRouter({
    projectDir: config.projectConfigDir,
    cwd: config.cwd,
    engine,
  });
}

/** 构造体检样例表（与 data-profile.test.ts 同源）：缺失率/低基数/时间跨度/金额列齐备 */
const SAMPLE_CSV = [
  "order_id,category,amount,note,sparse,order_time",
  "O1,app,10.5,X,,2024-06-01 00:00:00",
  "O2,web,20.0,X,,2024-06-02 00:00:00",
  "O3,app,,X,,2024-06-03 00:00:00",
  "O4,web,15.5,X,,2024-06-04 00:00:00",
  "O5,app,12.0,X,,2024-06-05 00:00:00",
  "O6,web,,X,,2024-06-06 00:00:00",
  "O7,app,18.2,X,,2024-06-07 00:00:00",
  "O8,web,,X,,2024-06-08 00:00:00",
  "O9,app,,,s1,",
].join("\n");

/** mock req/res 直接调用路由（沿用 upload-autoload.test.ts 的风格） */
async function invokeRouter(
  router: ReturnType<typeof createDatasetsRouter>,
  opts: { method: string; path: string }
): Promise<{ statusCode: number; body: any }> {
  const req = {
    method: opts.method,
    url: opts.path,
    originalUrl: opts.path,
    path: opts.path,
    headers: {},
    params: {},
    query: {},
    body: undefined,
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as Request;

  let statusCode = 0;
  let resBody: unknown;
  let resolveJson: (() => void) | null = null;
  const jsonDone = new Promise<void>((resolve) => { resolveJson = resolve; });

  const res = {
    status(code: number) { statusCode = code; return this; },
    json(data: unknown) {
      resBody = data;
      statusCode = statusCode || 200;
      resolveJson?.();
      return this;
    },
    setHeader() { return this; },
    type() { return this; },
    send() { resolveJson?.(); return this; },
  } as unknown as Response;

  router(req, res, () => resolveJson?.());
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

describe("GET /api/datasets/:table/profile（v0.10.2 体检卡常驻化）", () => {
  it("PF1: 返回结构化 TableProfile", async () => {
    const router = await setup();
    const csvPath = join(tmpDir!, "orders.csv");
    writeFileSync(csvPath, SAMPLE_CSV);
    await engine!.exec(`CREATE TABLE orders AS SELECT * FROM read_csv_auto('${csvPath}')`);

    const { statusCode, body } = await invokeRouter(router, {
      method: "GET",
      path: "/api/datasets/orders/profile",
    });

    expect(statusCode).toBe(200);
    const profile = body?.data?.profile;
    expect(profile).toBeDefined();
    expect(profile.tableName).toBe("orders");
    expect(profile.rowCount).toBe(9);
    expect(profile.columnCount).toBe(6);
    expect(Array.isArray(profile.suggestedQuestions)).toBe(true);
    expect(profile.suggestedQuestions.length).toBeGreaterThanOrEqual(1);
    expect(profile.suggestedQuestions.length).toBeLessThanOrEqual(3);
    // 缺失率结构（amount 有空值 → 需关注列表）
    expect(profile.missingColumns.some((c: { name: string }) => c.name === "amount")).toBe(true);
    // 时间跨度（order_time 为 TIMESTAMP 列）
    expect(profile.timeSpan?.column).toBe("order_time");
  });

  it("PF2: 未知表返回 404 TABLE_NOT_FOUND", async () => {
    const router = await setup();
    const { statusCode, body } = await invokeRouter(router, {
      method: "GET",
      path: "/api/datasets/no_such_table/profile",
    });
    expect(statusCode).toBe(404);
    expect(body?.error?.code).toBe("TABLE_NOT_FOUND");
  });

  it("PF3: 非法表名返回 400 INVALID_TABLE_NAME", async () => {
    const router = await setup();
    const { statusCode, body } = await invokeRouter(router, {
      method: "GET",
      path: "/api/datasets/bad%20name/profile",
    });
    expect(statusCode).toBe(400);
    expect(body?.error?.code).toBe("INVALID_TABLE_NAME");
  });

  it("PF4: engine 为 null 时返回 503 ENGINE_UNAVAILABLE", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-ds-profile-null-"));
    const config = makeIsolatedConfig(tmpDir);
    const router = createDatasetsRouter({
      projectDir: config.projectConfigDir,
      cwd: config.cwd,
      engine: null,
    });
    const { statusCode, body } = await invokeRouter(router, {
      method: "GET",
      path: "/api/datasets/whatever/profile",
    });
    expect(statusCode).toBe(503);
    expect(body?.error?.code).toBe("ENGINE_UNAVAILABLE");
  });
});
