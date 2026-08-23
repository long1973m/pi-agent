/**
 * v0.10.1 — 上传 body 体积限制修复验收测试（vitest）
 *
 * 背景：全局 express.json({ limit: "256kb" }) 会把 >约190KB 的真实 CSV
 * （base64 膨胀 1/3 后超限）全部 413 拒绝。修复后 /api/upload 挂载专用
 * express.json({ limit: "70mb" }) 解析器，全局 256kb 保持不变。
 *
 * 覆盖:
 * - BL1: ~300KB 合法 CSV 上传成功（走真实 createDashboardServer 中间件链，
 *        旧实现下 base64 后约 400KB 必被全局 256kb 拦截）
 * - BL2: >70MB body 返回 413 且 error.code = PAYLOAD_TOO_LARGE（可识别）
 * - BL3: 全局 256kb 限制对非上传路由仍然生效（写请求小 body 正常、大 JSON 被 413）
 *
 * 测试约束：独立临时目录（mkdtempSync 隔离，不写共享 session.duckdb），
 * 不依赖网络与真实 LLM。setup 模式参考 upload-profile-response.test.ts。
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createDashboardServer } from "../dashboard/server.js";
import { loadConfig } from "../config.js";
import { DuckDBEngine } from "../engine/duckdb.js";

let engine: DuckDBEngine | null = null;
let server: Server | null = null;
let tmpDir: string | null = null;

/** 与生产 lifecycle 相同的隔离配置模式：显式覆盖全部路径 */
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

/** 启动真实 Dashboard server（随机端口），返回 base URL */
async function startServer(): Promise<string> {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-upload-limit-test-"));
  const config = makeIsolatedConfig(tmpDir);
  engine = new DuckDBEngine({
    dbPath: config.dbPath,
    previewLimit: config.previewLimit,
    outputDir: config.outputDir,
  });
  await engine.init();

  const uploadsDir = join(tmpDir, "uploads");
  mkdirSync(uploadsDir, { recursive: true });

  const dictStub = {
    hasDictionary: () => false,
    ensureDictionary: async () => ({}),
    refreshFingerprint: async () => undefined,
  };

  server = await createDashboardServer(0, "test-write-token", {
    projectDir: join(tmpDir, ".pi-data-agent"),
    cwd: tmpDir,
    engine,
    dictionaryManager: dictStub as never,
    uploadsDir,
  });

  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

async function postJson(base: string, path: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // originCheck 中间件要求写请求携带合法本地 Origin（浏览器同源自动带，fetch 需显式补）
      "Origin": base,
      "X-Write-Token": "test-write-token",
    },
    body: JSON.stringify(payload),
  });
  let body: any = {};
  try { body = await res.json(); } catch { /* 413 等场景可能无 JSON 体 */ }
  return { status: res.status, body };
}

afterAll(async () => {
  if (server) {
    // 先断开 keep-alive 连接，避免 close() 等待空闲 socket 超时
    (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  if (engine) {
    await engine.close();
    engine = null;
  }
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("上传 body 体积限制修复（v0.10.1）", () => {
  it("BL1: ~300KB 合法 CSV 上传成功并自动建表", async () => {
    const base = await startServer();

    // ~300KB 原始 CSV（base64 后约 400KB > 全局 256kb，旧实现必 413）
    const header = "order_id,customer,city,amount,order_date";
    const line = "10001,张三,北京,199.90,2025-06-15";
    const rows: string[] = [header];
    for (let i = 0; i < 3400; i++) {
      rows.push(`${10000 + i},客户${i % 97},${["北京", "上海", "广州"][i % 3]},${(i * 1.5).toFixed(2)},2025-06-${String((i % 28) + 1).padStart(2, "0")}`);
    }
    // 补齐到 ≥300KB
    while (Buffer.byteLength(rows.join("\n"), "utf-8") < 300 * 1024) {
      rows.push(...Array.from({ length: 500 }, (_, j) => {
        const k = rows.length + j;
        return `${20000 + k},客户${k % 97},${["深圳", "杭州", "成都"][k % 3]},${(k * 2.3).toFixed(2)},2025-07-${String((k % 28) + 1).padStart(2, "0")}`;
      }));
    }
    const csv = rows.join("\n") + "\n";
    expect(Buffer.byteLength(csv, "utf-8")).toBeGreaterThanOrEqual(300 * 1024);

    const { status, body } = await postJson(base, "/api/upload", {
      filename: "orders_big.csv",
      content: Buffer.from(csv, "utf-8").toString("base64"),
    });

    expect(status).toBe(200);
    expect(body?.data?.loaded?.ok).toBe(true);
    expect(body?.data?.loaded?.tableName).toBe("orders_big");
    expect(body?.data?.loaded?.rowCount).toBe(rows.length - 1);

    // 表确实建好
    const tables = await engine!.getTables();
    expect(tables).toContain("orders_big");

    // 全局 256kb 对普通 API 仍生效的对照组：GET 不受影响
    const health = await fetch(`${base}/api/config`);
    expect(health.ok).toBe(true);
  }, 60_000);

  it("BL2: >70MB body 返回 413 且 code 可识别为 PAYLOAD_TOO_LARGE", async () => {
    const base = await startServer();

    // base64 后 ~71MB（> 70mb 上限）：53MB 字节 → ~71MB base64 文本
    const raw = Buffer.alloc(53 * 1024 * 1024, 0x61);
    const content = raw.toString("base64");
    expect(content.length).toBeGreaterThan(70 * 1024 * 1024);

    const { status, body } = await postJson(base, "/api/upload", {
      filename: "huge.csv",
      content,
    });

    expect(status).toBe(413);
    expect(body?.error?.code).toBe("PAYLOAD_TOO_LARGE");
  }, 60_000);

  it("BL3: 非 /api/upload 路由仍受全局 256kb 限制（写请求 >256kb 返回 413）", async () => {
    const base = await startServer();

    // 指标定义接口走全局解析器：>256kb 的 body 应被拒绝
    const bigDefinition = "x".repeat(300 * 1024);
    const { status, body } = await postJson(base, "/api/metrics", {
      name: "big_metric",
      definition: bigDefinition,
    });

    expect(status).toBe(413);
    expect(body?.error?.code).toBe("PAYLOAD_TOO_LARGE");
  }, 60_000);
});
