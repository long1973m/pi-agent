/**
 * v0.12 — Dashboard 删除表能力验收测试（vitest）
 *
 * 覆盖 DELETE /api/datasets/:table：
 * - D1: 正常删除 → 200 dropped:true，表从引擎消失
 * - D2: 缺 confirm → 400 CONFIRM_REQUIRED（fail-closed）
 * - D3: confirm 值与表名不匹配 → 400 CONFIRM_REQUIRED
 * - D4: 非法表名 → 400 INVALID_TABLE_NAME
 * - D5: 未知表 → 404 TABLE_NOT_FOUND
 * - D6: engine 为 null → 503 ENGINE_UNAVAILABLE
 * - D7: 级联清理——表卡片与字典条目随删表一并清理
 *
 * 测试约束：独立临时目录（不写共享 session.duckdb），不依赖网络与真实 LLM。
 * 复用 datasets-profile.test.ts 的 mock req/res 路由调用范式。
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Request, Response } from "express";

import { createDatasetsRouter } from "../dashboard/routes/datasets.js";
import { loadConfig } from "../config.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { TableCardStore } from "../table-cards/store.js";
import { DataDictionaryManager } from "../hooks/data-dictionary.js";
import { PersistenceManager } from "../persistence.js";

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

async function setup(opts?: {
  withDictionary?: boolean;
}): Promise<{
  router: ReturnType<typeof createDatasetsRouter>;
  dictionaryManager?: DataDictionaryManager;
}> {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-ds-delete-test-"));
  const config = makeIsolatedConfig(tmpDir);
  engine = new DuckDBEngine({
    dbPath: config.dbPath,
    previewLimit: config.previewLimit,
    outputDir: config.outputDir,
  });
  await engine.init();

  const deps: Parameters<typeof createDatasetsRouter>[0] = {
    projectDir: config.projectConfigDir,
    cwd: config.cwd,
    engine,
  };

  let dictionaryManager: DataDictionaryManager | undefined;
  if (opts?.withDictionary) {
    const persistence = new PersistenceManager(
      join(tmpDir, "global-config"),
      config.projectConfigDir,
    );
    dictionaryManager = new DataDictionaryManager(persistence);
    deps.dictionaryManager = dictionaryManager;
  }

  return { router: createDatasetsRouter(deps), dictionaryManager };
}

/** 样例 CSV（两列小表即可） */
const SAMPLE_CSV = ["id,name", "1,alice", "2,bob"].join("\n");

async function createSampleTable(tableName: string): Promise<void> {
  const csvPath = join(tmpDir!, `${tableName}.csv`);
  writeFileSync(csvPath, SAMPLE_CSV);
  await engine!.exec(
    `CREATE TABLE ${tableName} AS SELECT * FROM read_csv_auto('${csvPath}')`
  );
}

/** mock req/res 直接调用路由（沿用 datasets-profile.test.ts 的风格） */
async function invokeRouter(
  router: ReturnType<typeof createDatasetsRouter>,
  opts: { method: string; path: string; body?: unknown }
): Promise<{ statusCode: number; body: any }> {
  const req = {
    method: opts.method,
    url: opts.path,
    originalUrl: opts.path,
    path: opts.path,
    headers: {},
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

describe("DELETE /api/datasets/:table（v0.12 删除表能力）", () => {
  it("D1: 正常删除 → 200 dropped:true，表从引擎消失", async () => {
    const { router } = await setup();
    await createSampleTable("orders");

    const { statusCode, body } = await invokeRouter(router, {
      method: "DELETE",
      path: "/api/datasets/orders",
      body: { confirm: "orders" },
    });

    expect(statusCode).toBe(200);
    expect(body?.data?.dropped).toBe(true);
    expect(body?.data?.table).toBe("orders");

    const tables = await engine!.getTables();
    expect(tables.includes("orders")).toBe(false);
  });

  it("D2: 缺 confirm 字段 → 400 CONFIRM_REQUIRED（fail-closed）", async () => {
    const { router } = await setup();
    await createSampleTable("orders");

    const { statusCode, body } = await invokeRouter(router, {
      method: "DELETE",
      path: "/api/datasets/orders",
    });

    expect(statusCode).toBe(400);
    expect(body?.error?.code).toBe("CONFIRM_REQUIRED");
    // 表未被删除
    expect((await engine!.getTables()).includes("orders")).toBe(true);
  });

  it("D3: confirm 值与表名不匹配 → 400 CONFIRM_REQUIRED", async () => {
    const { router } = await setup();
    await createSampleTable("orders");

    const { statusCode, body } = await invokeRouter(router, {
      method: "DELETE",
      path: "/api/datasets/orders",
      body: { confirm: "other_table" },
    });

    expect(statusCode).toBe(400);
    expect(body?.error?.code).toBe("CONFIRM_REQUIRED");
    expect((await engine!.getTables()).includes("orders")).toBe(true);
  });

  it("D4: 非法表名 → 400 INVALID_TABLE_NAME", async () => {
    const { router } = await setup();
    const { statusCode, body } = await invokeRouter(router, {
      method: "DELETE",
      path: "/api/datasets/bad%20name",
      body: { confirm: "bad name" },
    });
    expect(statusCode).toBe(400);
    expect(body?.error?.code).toBe("INVALID_TABLE_NAME");
  });

  it("D5: 未知表 → 404 TABLE_NOT_FOUND", async () => {
    const { router } = await setup();
    const { statusCode, body } = await invokeRouter(router, {
      method: "DELETE",
      path: "/api/datasets/no_such_table",
      body: { confirm: "no_such_table" },
    });
    expect(statusCode).toBe(404);
    expect(body?.error?.code).toBe("TABLE_NOT_FOUND");
  });

  it("D6: engine 为 null → 503 ENGINE_UNAVAILABLE", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-ds-delete-null-"));
    const config = makeIsolatedConfig(tmpDir);
    const router = createDatasetsRouter({
      projectDir: config.projectConfigDir,
      cwd: config.cwd,
      engine: null,
    });
    const { statusCode, body } = await invokeRouter(router, {
      method: "DELETE",
      path: "/api/datasets/whatever",
      body: { confirm: "whatever" },
    });
    expect(statusCode).toBe(503);
    expect(body?.error?.code).toBe("ENGINE_UNAVAILABLE");
  });

  it("D7: 级联清理——表卡片与字典条目随删表一并清理", async () => {
    const { router, dictionaryManager } = await setup({ withDictionary: true });
    await createSampleTable("orders");

    // 预置表卡片
    const cardStore = new TableCardStore(join(tmpDir!, ".pi-data-agent"));
    cardStore.put(
      "orders",
      { status: "user-confirmed", summary: "订单样例表", suitableFor: [], boundaries: [], whenToUse: [], tags: ["样例"] },
      -1,
    );
    expect(cardStore.get("orders")).not.toBeNull();

    // 预置字典条目（路由内的 dictionaryManager 与这里是同一实例）
    await dictionaryManager!.ensureDictionary("orders", engine!);
    expect(dictionaryManager!.hasDictionary("orders")).toBe(true);

    const { statusCode, body } = await invokeRouter(router, {
      method: "DELETE",
      path: "/api/datasets/orders",
      body: { confirm: "orders" },
    });

    expect(statusCode).toBe(200);
    expect(body?.data?.cleaned?.tableCard).toBe(true);
    expect(body?.data?.cleaned?.dictionary).toBe(true);

    // 两个关联资产确实被清掉
    expect(cardStore.get("orders")).toBeNull();
    expect(dictionaryManager!.hasDictionary("orders")).toBe(false);
  });
});
