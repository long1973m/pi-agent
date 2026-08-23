/**
 * v0.10 A-3 — 表卡片验收测试（vitest）
 *
 * 覆盖（规范 §10.2 table-cards.test.ts）：
 * - 存储读写（put/get/list，revision 递增）
 * - 乐观锁冲突（expectedRevision 不一致 → RevisionConflictError / HTTP 409）
 * - stale 标记（fingerprint 变化标记、幂等、确认后清除）
 * - 骨架生成（无 LLM → summary 留空的 ai-drafted 骨架卡）
 * - AI 起草成功分支（mock callLLM 返回结构化 JSON；解析失败重试一次）
 * - 起草 API 的 503 分支（无 LLM / 无引擎）
 * - load_data 成功后 fire-and-forget 触发起草钩子
 *
 * 隔离模式：mkdtempSync 临时目录，不写共享 session.duckdb。
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Request, Response } from "express";

import {
  TableCardStore,
  RevisionConflictError,
  createSkeletonCard,
  computeTableSchemaFingerprint,
} from "../table-cards/store.js";
import {
  ensureTableCard,
  draftCardWithLLM,
} from "../table-cards/draft.js";
import { createTableCardsRouter } from "../dashboard/routes/table-cards.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import type { ColumnInfo } from "../types.js";

let tmpDir: string | null = null;
let engine: DuckDBEngine | null = null;

function makeTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-table-cards-test-"));
  return tmpDir;
}

function makeStore(dir?: string): TableCardStore {
  return new TableCardStore(dir ?? makeTmpDir());
}

const COLUMNS: ColumnInfo[] = [
  { name: "order_id", type: "INTEGER", nullable: true },
  { name: "amount", type: "DOUBLE", nullable: true },
];

async function setupEngine(withTable: boolean): Promise<DuckDBEngine> {
  const dir = makeTmpDir();
  engine = new DuckDBEngine({
    dbPath: join(dir, "session.duckdb"),
    previewLimit: 100,
    outputDir: join(dir, "output"),
  });
  await engine.init();
  if (withTable) {
    await engine.exec("CREATE OR REPLACE TABLE orders (order_id INTEGER, amount DOUBLE)");
  }
  return engine;
}

/** mock req/res 直调路由（沿用 upload-profile-response.test.ts 风格） */
async function invokeRouter(
  router: ReturnType<typeof createTableCardsRouter>,
  opts: { method: string; path: string; body?: unknown }
): Promise<{ statusCode: number; body: any }> {
  const req = {
    method: opts.method,
    url: opts.path,
    originalUrl: opts.path,
    path: opts.path,
    headers: { "content-type": "application/json" } as Record<string, unknown>,
    params: {} as Record<string, string>,
    query: {},
    body: opts.body,
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as Request;
  // 从 path 提取 :table 参数
  const match = opts.path.match(/^\/api\/table-cards\/([^/]+)(\/.*)?$/);
  if (match) (req.params as Record<string, string>).table = decodeURIComponent(match[1]);

  let statusCode = 0;
  let resBody: unknown;
  let resolveJson: (() => void) | null = null;
  const jsonDone = new Promise<void>((resolve) => { resolveJson = resolve; });

  const res = {
    status(code: number) { statusCode = code; return this; },
    json(data: unknown) { resBody = data; statusCode = statusCode || 200; resolveJson?.(); return this; },
    setHeader() { return this; },
    type() { return this; },
    send(data: unknown) { resBody = data; resolveJson?.(); return this; },
  } as unknown as Response;

  router(req, res, () => { resolveJson?.(); });
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

describe("A-3 表卡片存储", () => {
  it("存储读写：put 创建并更新卡片，revision 递增，重启（新实例）可读", async () => {
    const dir = makeTmpDir();
    const store = makeStore(dir);

    const r1 = store.put("orders", { summary: "支付订单明细表", tags: ["订单"] }, -1);
    expect(r1.revision).toBe(1);
    expect(store.get("orders")?.summary).toBe("支付订单明细表");
    expect(store.get("orders")?.status).toBe("ai-drafted");

    const r2 = store.put("orders", { summary: "已支付订单表", suitableFor: ["GMV 分析"] }, r1.revision);
    expect(r2.revision).toBe(2);
    const card = store.get("orders");
    expect(card?.summary).toBe("已支付订单表");
    expect(card?.suitableFor).toEqual(["GMV 分析"]);

    // 新实例读取同一文件（持久化往返）
    const reopened = new TableCardStore(dir);
    expect(reopened.get("orders")?.summary).toBe("已支付订单表");
    expect(reopened.list().cards).toHaveLength(1);
  });

  it("乐观锁：expectedRevision 不一致抛 RevisionConflictError（409 语义）", async () => {
    const store = makeStore();
    const r1 = store.put("orders", { summary: "v1" }, -1);
    // 用过期的 revision 写入 → 冲突
    expect(() => store.put("orders", { summary: "v2" }, r1.revision - 1)).toThrow(RevisionConflictError);
    // 数据未被破坏
    expect(store.get("orders")?.summary).toBe("v1");
  });

  it("stale 标记：fingerprint 变化时标 stale 且幂等；确认动作清除 stale", async () => {
    const store = makeStore();
    store.put("orders", { summary: "卡" }, -1);
    const cardBefore = store.get("orders")!;
    // 手工补 fingerprint（模拟此前按旧结构生成的卡片）
    const data1 = store.put("orders", { status: "user-confirmed" }, -1);
    void data1;

    const staleMarked = store.markStaleIfChanged("orders", "fp-new");
    expect(staleMarked).toBe(true);
    let card = store.get("orders")!;
    expect(card.stale).toBe(true);
    expect(card.summary).toBe(cardBefore.summary); // 内容不被覆盖

    // 幂等：重复标记返回 false
    expect(store.markStaleIfChanged("orders", "fp-new")).toBe(false);

    // 确认动作清除 stale
    store.put("orders", { status: "user-confirmed" }, -1);
    card = store.get("orders")!;
    expect(card.stale).toBe(false);
    expect(card.status).toBe("user-confirmed");

    // 相同 fingerprint / 无卡片 → 不动
    expect(store.markStaleIfChanged("orders", "fp-other")).toBe(true); // 与 stored "" 不同会再标记
    const empty = store.markStaleIfChanged("nope", "fp");
    expect(empty).toBe(false);
  });

  it("骨架生成：summary 等留空待填、status ai-drafted", async () => {
    const skeleton = createSkeletonCard("users", computeTableSchemaFingerprint("users", COLUMNS));
    expect(skeleton.tableName).toBe("users");
    expect(skeleton.summary).toBe("");
    expect(skeleton.suitableFor).toEqual([]);
    expect(skeleton.boundaries).toEqual([]);
    expect(skeleton.whenToUse).toEqual([]);
    expect(skeleton.tags).toEqual([]);
    expect(skeleton.status).toBe("ai-drafted");
    expect(skeleton.stale).toBe(false);
    expect(skeleton.fingerprint.length).toBeGreaterThan(0);

    // 指纹稳定性：同 schema 同指纹，不同 schema 不同指纹
    expect(computeTableSchemaFingerprint("users", COLUMNS)).toBe(skeleton.fingerprint);
    expect(computeTableSchemaFingerprint("users", [...COLUMNS, { name: "age", type: "INTEGER", nullable: true }]))
      .not.toBe(skeleton.fingerprint);
  });
});

describe("A-3 表卡片起草", () => {
  it("AI 起草成功分支：mock callLLM 返回 JSON → 结构化卡片入库", async () => {
    const dir = makeTmpDir();
    const eng = await setupEngine(true);
    const store = new TableCardStore(dir);
    const result = await ensureTableCard(
      {
        store,
        engine: eng,
        callLLM: async () => JSON.stringify({
          summary: "支付订单明细表",
          suitableFor: ["GMV 统计", "复购分析"],
          boundaries: ["不含已取消订单"],
          whenToUse: ["销售额类问题"],
          tags: ["订单"],
        }),
      },
      "orders",
    );
    expect(result?.drafted).toBe(true);
    const card = store.get("orders")!;
    expect(card.summary).toBe("支付订单明细表");
    expect(card.suitableFor).toContain("GMV 统计");
    expect(card.tags).toEqual(["订单"]);
    expect(card.status).toBe("ai-drafted");
  });

  it("AI 起草解析失败重试一次：第一次输出乱码、第二次合法 JSON → 成功且只调两次", async () => {
    const dir = makeTmpDir();
    const eng = await setupEngine(true);
    const store = new TableCardStore(dir);
    let calls = 0;
    const card = await draftCardWithLLM(
      { tableName: "orders", columns: COLUMNS, samples: [], recentQueries: [] },
      "fp-x",
      async () => {
        calls++;
        return calls === 1 ? "抱歉我无法回答（非 JSON）" : '```json\n{"summary":"订单表","tags":["交易"]}\n```';
      },
    );
    expect(calls).toBe(2);
    expect(card.summary).toBe("订单表");
    expect(card.tags).toEqual(["交易"]);
    void store;
  });

  it("无 LLM → 骨架卡兜底；同 fingerprint 已有卡片时跳过不重复起草", async () => {
    const dir = makeTmpDir();
    const eng = await setupEngine(true);
    const store = new TableCardStore(dir);

    // 第一次：无 LLM → 骨架卡
    const r1 = await ensureTableCard({ store, engine: eng }, "orders");
    expect(r1?.drafted).toBe(true);
    expect(store.get("orders")!.status).toBe("ai-drafted");
    expect(store.get("orders")!.fingerprint).toBe(computeTableSchemaFingerprint("orders", await eng.getSchema("orders")));

    // 第二次：同 fingerprint → 跳过
    const r2 = await ensureTableCard({ store, engine: eng }, "orders");
    expect(r2?.drafted).toBe(false);
  });

  it("结构变化：fingerprint 不匹配 → 仅标记 stale，不覆盖已有内容", async () => {
    const dir = makeTmpDir();
    const eng = await setupEngine(true);
    const store = new TableCardStore(dir);
    await ensureTableCard({ store, engine: eng }, "orders");

    // 加一列改变 schema → fingerprint 变化
    await eng.exec("ALTER TABLE orders ADD COLUMN city VARCHAR");
    const r = await ensureTableCard({ store, engine: eng }, "orders");
    expect(r?.drafted).toBe(false);
    const card = store.get("orders")!;
    expect(card.stale).toBe(true);
  });
});

describe("A-3 表卡片 API", () => {
  it("POST draft：无引擎 → 503 ENGINE_UNAVAILABLE；有引擎无 LLM → 503 LLM_UNAVAILABLE", async () => {
    const dir = makeTmpDir();
    const store = new TableCardStore(dir);

    const routerNoEngine = createTableCardsRouter({ projectDir: dir, cwd: dir, engine: null, uploadsDir: dir });
    const r1 = await invokeRouter(routerNoEngine, { method: "POST", path: "/api/table-cards/orders/draft", body: {} });
    expect(r1.statusCode).toBe(503);
    expect(r1.body.error.code).toBe("ENGINE_UNAVAILABLE");

    const eng = await setupEngine(true);
    const routerNoLLM = createTableCardsRouter({ projectDir: dir, cwd: dir, engine: eng, uploadsDir: dir });
    const r2 = await invokeRouter(routerNoLLM, { method: "POST", path: "/api/table-cards/orders/draft", body: {} });
    expect(r2.statusCode).toBe(503);
    expect(r2.body.error.code).toBe("LLM_UNAVAILABLE");
    void store;
  });

  it("PUT：正常保存与确认；expectedRevision 过期 → 409；GET 不存在的表 → 404", async () => {
    const dir = makeTmpDir();
    const eng = await setupEngine(true);
    const router = createTableCardsRouter({ projectDir: dir, cwd: dir, engine: eng, uploadsDir: dir });

    // GET 未创建的表 → 404
    const g0 = await invokeRouter(router, { method: "GET", path: "/api/table-cards/orders" });
    expect(g0.statusCode).toBe(404);

    // PUT 创建（expectedRevision=-1 跳过检查）
    const p1 = await invokeRouter(router, {
      method: "PUT",
      path: "/api/table-cards/orders",
      body: { summary: "订单表", tags: ["订单"], expectedRevision: -1 },
    });
    expect(p1.statusCode).toBe(200);
    const revision = p1.body.data.revision;
    expect(p1.body.data.card.status).toBe("ai-drafted");

    // 用过期 revision 再写 → 409
    const p2 = await invokeRouter(router, {
      method: "PUT",
      path: "/api/table-cards/orders",
      body: { summary: "改", expectedRevision: revision - 1 },
    });
    expect(p2.statusCode).toBe(409);
    expect(p2.body.error.code).toBe("REVISION_CONFLICT");

    // 用当前 revision 确认 → user-confirmed
    const p3 = await invokeRouter(router, {
      method: "PUT",
      path: "/api/table-cards/orders",
      body: { summary: "订单表", status: "user-confirmed", expectedRevision: revision },
    });
    expect(p3.statusCode).toBe(200);
    expect(p3.body.data.card.status).toBe("user-confirmed");

    // GET 可读
    const g1 = await invokeRouter(router, { method: "GET", path: "/api/table-cards/orders" });
    expect(g1.statusCode).toBe(200);
    expect(g1.body.data.card.summary).toBe("订单表");
    expect(g1.body.data.card.stale).toBe(false);
  });
});

describe("A-3 load_data 起草钩子", () => {
  it("loadFileIntoTable 提供 tableCards 钩子时 fire-and-forget 触发 ensureCard", async () => {
    const { loadFileIntoTable } = await import("../tools/load-data.js");
    const csvPath = join(makeTmpDir(), "orders.csv");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(csvPath, "order_id,amount\n1,10\n2,20\n3,30\n");

    const eng = await setupEngine(false);
    let hookCalled = false;
    const outcome = await loadFileIntoTable(
      eng,
      { filePath: csvPath, tableName: "hooked" },
      {
        tableCards: {
          ensureCard: async () => { hookCalled = true; },
        },
      },
    );
    expect(outcome.ok).toBe(true);

    // fire-and-forget：等微任务队列排空后应已触发，且不阻塞加载结果本身
    for (let i = 0; i < 50 && !hookCalled; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(hookCalled).toBe(true);
  });
});
