/**
 * v0.9 A-2 — Dashboard 上传自动加载验收测试（vitest）
 *
 * 覆盖:
 * - U1: 上传 CSV → 自动建表，响应含 loaded.tableName / rowCount / columnCount，引擎中立即可查
 * - U2: 同名表覆盖 → loaded.replaced = true
 * - U3: 坏文件 → 上传成功（HTTP 200 结构完整）、loaded.ok=false 且 reason 可读
 * - U4: >100MB → 跳过自动加载并给出手动加载指引
 * - U5: 响应结构保留原有字段（path/name/originalName/size/uploadedAt）
 * - U6: 现有安全约束不变——非法文件名 400、不支持扩展名 400、>50MB 413
 * - U7: 上传 xlsx 同样自动加载（依赖 A-1）
 *
 * 测试约束：独立临时目录（不写共享 session.duckdb），不依赖网络与真实 LLM。
 */

import { describe, it, expect, afterEach } from "vitest";
import * as XLSX from "xlsx";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Request, Response } from "express";

import { createUploadRouter, autoLoadUploadedFile, type UploadDeps } from "../dashboard/routes/upload.js";
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
  tmpDir = mkdtempSync(join(tmpdir(), "pi-upload-test-"));
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

/** 构造 mock req/res 并直接调用 router（沿用 dashboard-security.test.ts 的 mock 风格） */
async function invokeRouter(
  router: ReturnType<typeof createUploadRouter>,
  opts: { method: string; path: string; body?: unknown; params?: Record<string, string> }
): Promise<{ statusCode: number; body: any }> {
  const req = {
    method: opts.method,
    url: opts.path,
    originalUrl: opts.path,
    path: opts.path,
    headers: { "content-type": "application/json" } as Record<string, unknown>,
    params: opts.params ?? {},
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

function uploadBody(filename: string, content: string): { filename: string; content: string } {
  return { filename, content };
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

describe("Dashboard 上传自动加载（A-2）", () => {
  it("U1: 上传 CSV 自动建表，响应含表概览", async () => {
    const { router } = await setup();
    const csv = "product,price\napple,3.5\nbanana,2.0\ncherry,8.8\n";
    const { statusCode, body } = await invokeRouter(router, {
      method: "POST",
      path: "/api/upload",
      body: uploadBody("fruits.csv", Buffer.from(csv).toString("base64")),
    });

    expect(statusCode).toBe(200);
    const loaded = body?.data?.loaded;
    expect(loaded.ok).toBe(true);
    expect(loaded.tableName).toBe("fruits");
    expect(loaded.rowCount).toBe(3);
    expect(loaded.columnCount).toBe(2);

    // Agent 侧立即可见该表
    const tables = await engine!.getTables();
    expect(tables).toContain("fruits");
  });

  it("U2: 同名表覆盖时 replaced=true", async () => {
    const { router } = await setup();
    const first = Buffer.from("a,b\n1,2\n").toString("base64");
    const second = Buffer.from("a,b\n1,2\n3,4\n5,6\n").toString("base64");

    await invokeRouter(router, { method: "POST", path: "/api/upload", body: uploadBody("data.csv", first) });
    const { body } = await invokeRouter(router, { method: "POST", path: "/api/upload", body: uploadBody("data.csv", second) });

    expect(body?.data?.loaded.ok).toBe(true);
    expect(body?.data?.loaded.replaced).toBe(true);
    expect(body?.data?.loaded.rowCount).toBe(3);
  });

  it("U3: 坏文件上传成功但 loaded.ok=false 且 reason 可读", async () => {
    const { router } = await setup();
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f, 0x00, 0x01]).toString("base64");
    const { statusCode, body } = await invokeRouter(router, {
      method: "POST",
      path: "/api/upload",
      body: uploadBody("broken.csv", garbage),
    });

    // 上传本身成功（落盘 + 200 结构）
    expect(statusCode).toBe(200);
    expect(body?.data?.path).toBeTruthy();
    expect(body?.data?.uploadedAt).toBeTruthy();

    const loaded = body?.data?.loaded;
    expect(loaded.ok).toBe(false);
    expect(typeof loaded.reason).toBe("string");
    expect(loaded.reason.length).toBeGreaterThan(0);
  });

  it("U4: >100MB 跳过自动加载并给出手动加载指引", async () => {
    const { router } = await setup();
    // 直接调用 autoLoadUploadedFile 验证跳过逻辑（不真的生成 100MB 文件）
    const result = await autoLoadUploadedFile(
      { engine: engine! },
      { filePath: join(tmpDir!, "big.csv"), originalName: "big.csv", size: 101 * 1024 * 1024 }
    );
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("文件较大");
    expect((result as { reason: string }).reason).toContain("手动加载");

    // 边界值：恰好 100MB 不跳过（会尝试真正加载，文件不存在 → 引擎错误 reason）
    const boundary = await autoLoadUploadedFile(
      { engine: engine! },
      { filePath: join(tmpDir!, "missing.csv"), originalName: "missing.csv", size: 100 * 1024 * 1024 }
    );
    expect(boundary.ok).toBe(false);
    // 引擎被触发了（报文件不存在的错误），说明没有被大小闸拦截
    expect((boundary as { reason: string }).reason).not.toContain("文件较大");

    void router;
  });

  it("U5: 响应保留原有字段", async () => {
    const { router, uploadsDir } = await setup();
    const { body } = await invokeRouter(router, {
      method: "POST",
      path: "/api/upload",
      body: uploadBody("legacy.csv", Buffer.from("x\n1\n").toString("base64")),
    });

    const data = body?.data;
    expect(data.path.startsWith(uploadsDir)).toBe(true);
    expect(data.originalName).toBe("legacy.csv");
    expect(data.name).toMatch(/^\d{13}_[0-9a-f-]{36}\.csv$/);
    expect(data.format).toBe("csv");
    expect(typeof data.size).toBe("number");
    expect(data.uploadedAt).toBeTruthy();
  });

  it("U6: 现有安全约束不变——非法文件名/扩展名/超大文件", async () => {
    const { router } = await setup();

    // 非法文件名
    const bad = await invokeRouter(router, {
      method: "POST",
      path: "/api/upload",
      body: uploadBody("../evil.csv", Buffer.from("x").toString("base64")),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body?.error?.code).toBe("INVALID_FILENAME");

    // 不支持的扩展名
    const exe = await invokeRouter(router, {
      method: "POST",
      path: "/api/upload",
      body: uploadBody("prog.exe", Buffer.from("MZ").toString("base64")),
    });
    expect(exe.statusCode).toBe(400);
    expect(exe.body?.error?.code).toBe("UNSUPPORTED_FORMAT");

    // >50MB → 413
    const big = await invokeRouter(router, {
      method: "POST",
      path: "/api/upload",
      body: uploadBody("huge.csv", Buffer.alloc(51 * 1024 * 1024, 97).toString("base64")),
    });
    expect(big.statusCode).toBe(413);
    expect(big.body?.error?.code).toBe("FILE_TOO_LARGE");
  });

  it("U7: 上传 xlsx 同样自动加载", async () => {
    const { router } = await setup();
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["名称", "库存"],
      ["键盘", 120],
      ["鼠标", 300],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "库存");
    const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const { statusCode, body } = await invokeRouter(router, {
      method: "POST",
      path: "/api/upload",
      body: uploadBody("inventory.xlsx", buf.toString("base64")),
    });

    expect(statusCode).toBe(200);
    const loaded = body?.data?.loaded;
    expect(loaded.ok).toBe(true);
    expect(loaded.tableName).toBe("inventory");
    expect(loaded.rowCount).toBe(2);
    expect(loaded.columnCount).toBe(2);

    const tables = await engine!.getTables();
    expect(tables).toContain("inventory");
  });

  it("U8: engine 不可用时 loaded.ok=false，上传不受影响", async () => {
    const { router } = await setup({ engine: null });
    const { statusCode, body } = await invokeRouter(router, {
      method: "POST",
      path: "/api/upload",
      body: uploadBody("ok.csv", Buffer.from("a\n1\n").toString("base64")),
    });

    expect(statusCode).toBe(200);
    expect(body?.data?.loaded.ok).toBe(false);
    expect(body?.data?.loaded.reason).toContain("DuckDB");
  });
});
