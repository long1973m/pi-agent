/**
 * v0.10 A-5 — SQL 历史频次化 + 固定记忆验收测试（vitest）
 *
 * 覆盖（规范 §10.2 query-memory-pin.test.ts）：
 * - pinned 绕过容量淘汰：maxEntries 满时 unpinned 被淘汰、pinned 全部保留
 * - pinned 注入渲染：getPinnedEntries 上限/排序 + L0 导航层"用户的高频/固定分析"小节
 * - 持久化往返：setPinned → saveQueryMemory 捕获 → 新 Manager 恢复后 pinned 仍在
 * - PATCH /api/sql-history/:entryId 的 pinned 字段走 AtomicStore 乐观锁并落盘
 * - useCount 与 pinned 相互独立
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Request, Response } from "express";

import { QueryMemoryManager } from "../hooks/query-memory.js";
import type { PersistenceManager } from "../persistence.js";
import type { QueryMemory, QueryMemoryEntry } from "../types.js";
import { createSqlHistoryRouter } from "../dashboard/routes/sql-history.js";
import { setWriteToken } from "../dashboard/middleware/write-token.js";
import type { DashboardDependencies } from "../dashboard/server.js";
import { renderNavContext, renderPinnedSection } from "../navigation/nav-context.js";

let tmpDir: string | null = null;

function makeTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-query-pin-test-"));
  return tmpDir;
}

/** 可捕获保存载荷的 mock PersistenceManager */
function makeMockPersistence(initial?: QueryMemory) {
  let memory: QueryMemory | undefined = initial;
  const saved: QueryMemory[] = [];
  return {
    persistence: {
      loadQueryMemory: () => (memory ? JSON.parse(JSON.stringify(memory)) : undefined),
      saveQueryMemory: (m: QueryMemory) => {
        saved.push(JSON.parse(JSON.stringify(m)));
        memory = JSON.parse(JSON.stringify(m));
      },
    } as unknown as PersistenceManager,
    saved,
    getMemory: () => (memory ? JSON.parse(JSON.stringify(memory)) : undefined),
  };
}

/** 构造一条记录参数（SQL 唯一以生成独立条目） */
function rec(i: number, fingerprint = "fp1") {
  return {
    naturalLanguageQuery: `问题 ${i}`,
    sql: `SELECT ${i} FROM orders`,
    datasetFingerprint: fingerprint,
    timestamp: new Date(Date.now() - (100 - i) * 1000).toISOString(),
  };
}

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("A-5 pinned 绕过容量淘汰", () => {
  it("容量满时：unpinned 条目被淘汰，pinned 条目全部保留", () => {
    const { persistence } = makeMockPersistence({ maxEntries: 3, entries: [] });
    const manager = new QueryMemoryManager(persistence);

    // 记录 3 条普通查询 → 满
    manager.recordQuery(rec(1));
    manager.recordQuery(rec(2));
    manager.recordQuery(rec(3));
    expect(manager.getMemory().entries.length).toBe(3);

    // 固定最早的一条
    const firstId = manager.getMemory().entries.find((e) => e.naturalLanguageQuery === "问题 1")!.id;
    expect(manager.setPinned(firstId, true)).toBe(true);

    // 再进 2 条新查询 → 触发两次淘汰；pinned 必须存活
    manager.recordQuery(rec(4));
    manager.recordQuery(rec(5));

    const entries = manager.getMemory().entries;
    expect(entries.some((e) => e.id === firstId && e.pinned)).toBe(true);
    expect(entries.length).toBeLessThanOrEqual(4); // 3 容量 + 淘汰跳过后可能临时超限
    // "问题 1" 不被淘汰
    expect(entries.some((e) => e.naturalLanguageQuery === "问题 1")).toBe(true);
  });

  it("全部 pinned 时放弃淘汰（不丢数据）", () => {
    const { persistence } = makeMockPersistence({ maxEntries: 2, entries: [] });
    const manager = new QueryMemoryManager(persistence);
    manager.recordQuery(rec(1));
    manager.recordQuery(rec(2));
    manager.getMemory().entries.forEach((e) => manager.setPinned(e.id, true));

    // 再进多条——没有可淘汰候选，条目持续保留
    manager.recordQuery(rec(3));
    manager.recordQuery(rec(4));
    const entries = manager.getMemory().entries;
    expect(entries.filter((e) => e.pinned).length).toBe(2);
  });

  it("取消固定后恢复参与淘汰语义（setPinned(false) 生效）", () => {
    const { persistence } = makeMockPersistence({ maxEntries: 2, entries: [] });
    const manager = new QueryMemoryManager(persistence);
    manager.recordQuery(rec(1));
    manager.recordQuery(rec(2));
    const id1 = manager.getMemory().entries[0].id;
    manager.setPinned(id1, true);
    manager.setPinned(id1, false);
    manager.recordQuery(rec(3)); // 触发淘汰，id1 可被淘汰

    const entries = manager.getMemory().entries;
    expect(entries.some((e) => e.pinned)).toBe(false);
  });

  it("useCount 与 pinned 相互独立：重复执行只加 useCount 不改 pinned", () => {
    const { persistence } = makeMockPersistence({ maxEntries: 5, entries: [] });
    const manager = new QueryMemoryManager(persistence);
    manager.recordQuery(rec(1));
    const id = manager.getMemory().entries[0].id;
    manager.setPinned(id, true);
    manager.recordQuery({ ...rec(1), naturalLanguageQuery: "换个问法同一 SQL" });

    const entry = manager.getMemory().entries[0];
    expect(entry.useCount).toBe(2);
    expect(entry.pinned).toBe(true);
  });
});

describe("A-5 pinned 注入渲染", () => {
  it("getPinnedEntries：只返回 pinned、新者优先、受 limit 限制", () => {
    const { persistence } = makeMockPersistence({ maxEntries: 20, entries: [] });
    const manager = new QueryMemoryManager(persistence);
    for (let i = 1; i <= 12; i++) manager.recordQuery(rec(i));
    const all = manager.getMemory().entries;
    // 固定其中前 11 条
    all.slice(0, 11).forEach((e) => manager.setPinned(e.id, true));

    const pinned = manager.getPinnedEntries(10);
    expect(pinned.length).toBe(10);
    expect(pinned.every((e) => e.pinned)).toBe(true);
    // 新者优先（rec(i) 时间戳随 i 递增）
    expect(new Date(pinned[0].timestamp).getTime()).toBeGreaterThanOrEqual(
      new Date(pinned[pinned.length - 1].timestamp).getTime()
    );
  });

  it("L0 导航层出现'用户的高频/固定分析'小节：每条一行 问题+表名，上限 10 条", () => {
    const { persistence } = makeMockPersistence({ maxEntries: 30, entries: [] });
    const manager = new QueryMemoryManager(persistence);
    for (let i = 1; i <= 12; i++) {
      manager.recordQuery({
        naturalLanguageQuery: `上个月 GMV 多少（变体 ${i}）`,
        sql: `SELECT SUM(amount) FROM orders WHERE x=${i}`,
        datasetFingerprint: "fp",
      });
    }
    manager.getMemory().entries.forEach((e) => manager.setPinned(e.id, true));

    const nav = renderNavContext({
      tables: [{ name: "orders", rowCount: 10, columnCount: 3 }],
      cards: new Map(),
      pinned: manager.getPinnedEntries(10),
      metrics: [],
    });
    expect(nav).toContain("用户的高频/固定分析");
    expect(nav).toContain('(orders)');
    // 12 条 pinned 只注入 10 行
    const sectionLines = nav.split("\n").filter((l) => l.startsWith('- "'));
    expect(sectionLines.length).toBe(10);
  });

  it("无 pinned 时不渲染该小节（renderPinnedSection 返回空串）", () => {
    expect(renderPinnedSection([])).toBe("");
    const nav = renderNavContext({
      tables: [{ name: "t", rowCount: 1, columnCount: 1 }],
      cards: new Map(),
      pinned: [],
      metrics: [],
    });
    expect(nav).not.toContain("用户的高频/固定分析");
  });
});

describe("A-5 pinned 持久化往返", () => {
  it("setPinned 后经持久化载荷重建 Manager，pinned 状态不丢", () => {
    const { persistence, saved } = makeMockPersistence({ maxEntries: 5, entries: [] });
    const manager = new QueryMemoryManager(persistence);
    manager.recordQuery(rec(1));
    manager.recordQuery(rec(2));
    const id = manager.getMemory().entries[0].id;
    manager.setPinned(id, true);

    // 至少触发过一次带 pinned 的保存
    expect(saved.some((m) => m.entries.some((e) => e.pinned))).toBe(true);

    // 用最终载荷重建（模拟重启）
    const finalMemory = saved[saved.length - 1];
    const { persistence: p2 } = makeMockPersistence(finalMemory);
    const manager2 = new QueryMemoryManager(p2);
    const restored = manager2.getMemory().entries.find((e) => e.id === id);
    expect(restored?.pinned).toBe(true);
    expect(manager2.getPinnedEntries().map((e) => e.id)).toContain(id);
  });

  it("PATCH /api/sql-history/:entryId 设置 pinned=true 并经 AtomicStore 落盘（revision 递增）", async () => {
    const dir = makeTmpDir();
    const projectDir = join(dir, ".pi-data-agent");

    // 预置旧版格式 query-memory.json（验证 QueryMemoryStore 自动迁移 + PATCH 写入）
    mkdirSync(projectDir, { recursive: true });
    const legacyEntry: QueryMemoryEntry = {
      id: "qm_pin_1",
      naturalLanguageQuery: "上月 GMV",
      sql: "SELECT SUM(amount) FROM orders",
      datasetFingerprint: "fp",
      timestamp: new Date().toISOString(),
      useCount: 3,
      success: true,
    };
    writeFileSync(join(projectDir, "query-memory.json"), JSON.stringify({ maxEntries: 5, entries: [legacyEntry] }), "utf-8");

    const deps = { projectDir, cwd: dir, engine: null, uploadsDir: dir } as unknown as DashboardDependencies;
    const router = createSqlHistoryRouter(deps);
    // PATCH 路由内联 writeTokenGuard：测试中注入固定令牌
    setWriteToken("test-write-token");

    const invoke = async (method: string, path: string, body?: unknown): Promise<{ statusCode: number; body: any }> => {
      const req = {
        method,
        url: path,
        originalUrl: path,
        path,
        headers: method.toUpperCase() === "PATCH" ? { "x-write-token": "test-write-token" } : {},
        params: { entryId: "qm_pin_1" },
        query: {},
        body,
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as Request;
      let statusCode = 0;
      let resBody: unknown;
      return await new Promise<{ statusCode: number; body: any }>((resolve) => {
        const res = {
          status(code: number) { statusCode = code; return this; },
          json(data: unknown) { resBody = data; statusCode = statusCode || 200; resolve({ statusCode, body: resBody }); return this; },
          setHeader() { return this; },
        } as unknown as Response;
        router(req, res, () => resolve({ statusCode: 404, body: null }));
      });
    };

    // GET 读取 revision
    const g1 = await invoke("GET", "/api/sql-history?page=1&size=10");
    expect(g1.statusCode).toBe(200);
    const revision = g1.body.revision;
    expect(g1.body.data.items[0].useCount).toBe(3);
    expect(g1.body.data.items[0].pinned).toBeFalsy();

    // PATCH pinned=true（带乐观锁）
    const p1 = await invoke("PATCH", "/api/sql-history/qm_pin_1", { pinned: true, expectedRevision: revision });
    expect(p1.statusCode).toBe(200);
    expect(p1.body.data.pinned).toBe(true);
    expect(p1.body.revision).toBe(revision + 1);

    // 过期 revision → 409
    const p2 = await invoke("PATCH", "/api/sql-history/qm_pin_1", { pinned: false, expectedRevision: revision });
    expect(p2.statusCode).toBe(409);

    // pinned 非法类型 → 400
    const p3 = await invoke("PATCH", "/api/sql-history/qm_pin_1", { pinned: "yes" });
    expect(p3.statusCode).toBe(400);

    // 落盘校验：文件为 RevisionedData 包装且 entry.pinned === true
    const raw = JSON.parse(readFileSync(join(projectDir, "query-memory.json"), "utf-8"));
    expect(raw.data.entries[0].pinned).toBe(true);
  });
});
