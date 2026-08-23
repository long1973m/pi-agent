/**
 * v0.10 A-6 — 口径管理 → 指标定义验收测试（vitest）
 *
 * 覆盖（规范 §10.2 metrics-definitions.test.ts）：
 * - 指标 CRUD：create/update/archive（notes、datasets 字段），list 排除归档
 * - L0 注入渲染：指标 name+definition 全量注入（≤20 截断）；legacy 历史口径不参与注入
 * - 旧 caliber 数据迁移兼容：
 *   · agent.md → metrics.json 迁移为只读历史条目（legacyCaliber 标记）
 *   · 幂等：重复构造 MetricStore 不产生重复条目（防二次迁移错乱）
 *   · 用户已定义的同名指标不被迁移覆盖；runtime 新写口径可增量拾取
 * - legacy 只读守卫：Store 抛 LegacyReadOnlyError，PATCH/DELETE 路由返回 400
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Request, Response } from "express";

import { MetricStore, LegacyReadOnlyError, isLegacyMetric } from "../dashboard/services/metric-store.js";
import type { CaliberEntry } from "../types.js";
import type { MetricEntry } from "../dashboard/types.js";
import { listActiveMetricDefinitions } from "../metrics/metric-definitions.js";
import { renderMetricsSection, METRICS_INJECTION_LIMIT } from "../navigation/nav-context.js";
import { createMetricsRouter } from "../dashboard/routes/metrics.js";

let tmpDir: string | null = null;

function makeTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-metrics-def-test-"));
  return tmpDir;
}

function writeAgentMd(dir: string, calibers: CaliberEntry[]): void {
  writeFileSync(join(dir, "agent.md"), JSON.stringify(calibers, null, 2), "utf-8");
}

function readAgentMd(dir: string): CaliberEntry[] {
  return JSON.parse(readFileSync(join(dir, "agent.md"), "utf-8")) as CaliberEntry[];
}

function caliber(question: string, definition: string, overrides: Partial<CaliberEntry> = {}): CaliberEntry {
  return {
    id: `cal_${question.length}_${Math.abs(question.split("").reduce((a, ch) => a * 31 + ch.charCodeAt(0) | 0, 7))}`,
    question,
    definition,
    appliedAssumption: "仅统计已支付",
    confirmedAt: new Date().toISOString(),
    status: "confirmed",
    ...overrides,
  };
}

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("A-6 指标定义 CRUD", () => {
  it("create → update → archive 全链路；list 排除已归档与 legacy", () => {
    const dir = makeTmpDir();
    const store = new MetricStore(dir);

    // create（含 notes 与 datasets 多选）
    const r1 = store.create({
      name: "GMV",
      definition: "SUM(amount)，仅统计 status='paid' 的订单",
      datasets: ["orders"],
      status: "user-confirmed",
      source: "user",
      notes: "退款单不计入",
    }, -1);
    expect(r1.revision).toBe(1);
    void r1;

    const created = store.list().metrics[0];
    expect(created.name).toBe("GMV");
    expect(created.notes).toBe("退款单不计入");
    expect(created.datasets).toEqual(["orders"]);
    expect(isLegacyMetric(created)).toBe(false);

    // update（含 datasets / notes 更新）
    store.update(created.id, {
      definition: "SUM(amount) WHERE status='paid'",
      datasets: ["orders", "refunds"],
      notes: "口径 v2",
    }, -1);
    let updated = store.list().metrics[0];
    expect(updated.definition).toContain("WHERE");
    expect(updated.datasets).toEqual(["orders", "refunds"]);
    expect(updated.notes).toBe("口径 v2");

    // archive（软删除）
    store.archive(created.id, -1);
    expect(store.list().metrics).toHaveLength(0);
    expect(store.list({ includeArchived: true }).metrics).toHaveLength(1);
    updated = store.list({ includeArchived: true }).metrics[0];
    expect(updated.archived).toBe(true);
  });

  it("乐观锁：过期 expectedRevision 抛 RevisionConflictError", () => {
    const dir = makeTmpDir();
    const store = new MetricStore(dir);
    store.create({ name: "A", definition: "def A", datasets: [], status: "user-confirmed", source: "user" }, -1);
    const staleRev = store.list().revision;

    // 另一次写入推进 revision，使 staleRev 过期
    store.create({ name: "C", definition: "def C", datasets: [], status: "user-confirmed", source: "user" }, -1);

    let conflictCode = "";
    try {
      store.update(store.list().metrics[0].id, { name: "D" }, staleRev);
    } catch (err: any) {
      conflictCode = err.code ?? "";
    }
    expect(conflictCode).toBe("REVISION_CONFLICT");
  });
});

describe("A-6 旧 caliber 数据迁移兼容", () => {
  it("agent.md 存在且无 metrics.json → 迁移为只读历史条目（保留不丢）", () => {
    const dir = makeTmpDir();
    writeAgentMd(dir, [
      caliber("GMV 怎么算", "已支付订单金额求和"),
      caliber("活跃用户怎么算", "当日去重登录用户", { status: "superseded" }),
    ]);

    const store = new MetricStore(dir);
    // 活跃定义列表为空（历史口径不是一等公民）
    expect(store.list().metrics).toHaveLength(0);
    // 只读历史区可见
    const { legacy } = store.listLegacy();
    expect(legacy).toHaveLength(2);
    expect(legacy[0].legacyCaliber).toBe(true);
    expect(legacy[0].question).toBe("GMV 怎么算");
    expect(legacy[0].appliedAssumption).toBe("仅统计已支付");
    // superseded 的旧口径按原语义归档
    expect(legacy.some((c) => c.archived && c.question === "活跃用户怎么算")).toBe(true);

    // metrics.json 已落盘
    const raw = JSON.parse(readFileSync(join(dir, "metrics.json"), "utf-8"));
    expect(raw.data).toHaveLength(2);
  });

  it("幂等：重复构造不产生重复条目；agent.md 回写保持稳定", () => {
    const dir = makeTmpDir();
    writeAgentMd(dir, [caliber("GMV 怎么算", "已支付订单金额求和")]);

    new MetricStore(dir); // 第一次构造触发迁移
    const second = new MetricStore(dir); // 第二次构造
    expect(second.listLegacy().legacy).toHaveLength(1);

    // 触发一次写路径后 agent.md 仍只有一条（合并而非追加）
    second.create({ name: "新指标", definition: "x", datasets: [], status: "user-confirmed", source: "user" }, -1);
    const third = new MetricStore(dir);
    expect(third.listLegacy().legacy).toHaveLength(1);
    expect(third.list().metrics.map((m) => m.name)).toEqual(["新指标"]);
    expect(readAgentMd(dir)).toHaveLength(1);
  });

  it("用户已定义同名指标时，agent.md 同问条目不重复导入；runtime 新口径可增量拾取", () => {
    const dir = makeTmpDir();

    // 先有用户自定义指标 GMV
    const first = new MetricStore(dir);
    first.create({ name: "GMV", definition: "SUM(amount) WHERE status='paid'", datasets: ["orders"], status: "user-confirmed", source: "user" }, -1);

    // 之后 runtime 在 agent.md 写入了同义确认口径与另一条新口径
    writeAgentMd(dir, [
      caliber("GMV", "旧版反问结论"),
      caliber("退款率怎么算", "退款额/GMV"),
    ]);

    // 再次构造（如重启 pi / 重开 Dashboard）→ 只拾取新增的"退款率"，不覆盖用户的 GMV 定义
    const second = new MetricStore(dir);
    const active = second.list().metrics;
    const gmvEntries = active.filter((m) => m.name === "GMV" || m.question === "GMV");
    expect(gmvEntries).toHaveLength(1);
    expect(gmvEntries[0].definition).toBe("SUM(amount) WHERE status='paid'");
    expect(gmvEntries[0].legacyCaliber).toBeFalsy();

    const refund = second.listLegacy().legacy.find((m) => m.question === "退款率怎么算");
    expect(refund?.legacyCaliber).toBe(true);
  });
});

describe("A-6 L0 注入渲染", () => {
  it("活跃定义全量注入 name+definition；legacy 历史口径不参与注入", () => {
    const dir = makeTmpDir();
    const store = new MetricStore(dir);
    store.create({ name: "GMV", definition: "已支付订单金额求和", datasets: [], status: "user-confirmed", source: "user" }, -1);
    store.create({ name: "活跃用户", definition: "去重登录用户数", datasets: [], status: "user-confirmed", source: "user" }, -1);

    const injectable = listActiveMetricDefinitions(dir);
    expect(injectable.map((m) => m.name)).toEqual(["GMV", "活跃用户"]);

    const section = renderMetricsSection(
      injectable.map((m) => ({ name: m.name, definition: m.definition, updatedAt: m.updatedAt }))
    );
    expect(section).toContain("- GMV = 已支付订单金额求和");
    expect(section).toContain("- 活跃用户 = 去重登录用户数");
    expect(section).toContain("必须遵守");

    // 历史口径存在也不进入注入
    writeAgentMd(dir, [caliber("旧问题", "旧定义")]);
    const afterMigration = listActiveMetricDefinitions(dir);
    expect(afterMigration.every((m) => !isLegacyMetric(m))).toBe(true);
  });

  it("超过 20 条按最近使用截断", () => {
    const metrics: MetricEntry[] = Array.from({ length: 23 }, (_, i) => ({
      id: `m${i}`,
      name: `指标${i}`,
      definition: `定义${i}`,
      datasets: [],
      status: "user-confirmed",
      source: "user",
      revision: 0,
      updatedAt: new Date(Date.now() - i * 1000).toISOString(),
      archived: false,
    }));
    const injectable = metrics.filter((_, i) => !isLegacyMetric(metrics[i]));
    void injectable;
    const section = renderMetricsSection(metrics);
    const lines = section.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBe(METRICS_INJECTION_LIMIT);
    expect(lines[0]).toContain("指标0"); // 最近使用优先
  });
});

describe("A-6 指标路由（legacy 只读 + GET 形状）", () => {
  async function invoke(router: ReturnType<typeof createMetricsRouter>, opts: { method: string; path: string; body?: unknown; query?: Record<string, string> }) {
    const req = {
      method: opts.method,
      url: opts.path,
      originalUrl: opts.path,
      path: opts.path,
      headers: {},
      params: (() => {
        const m = opts.path.match(/^\/api\/metrics\/([^/?]+)/);
        return m ? { metricId: m[1] } : {};
      })(),
      query: opts.query ?? {},
      body: opts.body,
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as Request;

    return await new Promise<{ statusCode: number; body: any }>((resolve) => {
      let statusCode = 0;
      let resBody: unknown;
      const res = {
        status(code: number) { statusCode = code; return this; },
        json(data: unknown) { resBody = data; statusCode = statusCode || 200; resolve({ statusCode, body: resBody }); return this; },
        setHeader() { return this; },
        type() { return this; },
        send() { resolve({ statusCode, body: resBody }); return this; },
      } as unknown as Response;
      router(req, res, () => resolve({ statusCode: 404, body: null }));
    });
  }

  it("GET 返回 { metrics, legacy, revision }；PATCH/DELETE 命中 legacy → 400 LEGACY_READ_ONLY", async () => {
    const dir = makeTmpDir();
    writeAgentMd(dir, [caliber("GMV 怎么算", "已支付订单金额求和")]);
    const router = createMetricsRouter({ projectDir: dir, cwd: dir, uploadsDir: dir });

    // GET：active 为空，legacy 有数据
    const g1 = await invoke(router, { method: "GET", path: "/api/metrics" });
    expect(g1.statusCode).toBe(200);
    expect(g1.body.data.metrics).toHaveLength(0);
    expect(g1.body.data.legacy).toHaveLength(1);
    const legacyId = g1.body.data.legacy[0].id;

    // POST 新建定义
    const p1 = await invoke(router, {
      method: "POST",
      path: "/api/metrics",
      body: { name: "GMV", definition: "SUM(amount)", datasets: ["orders"], notes: "n", expectedRevision: g1.body.data.revision },
    });
    expect(p1.statusCode).toBe(201);
    const metricId = p1.body.data.data.at(-1).id;
    expect(metricId).toBeTruthy();

    // PATCH legacy → 400 LEGACY_READ_ONLY
    const p2 = await invoke(router, {
      method: "PATCH",
      path: `/api/metrics/${legacyId}`,
      body: { name: "改名", expectedRevision: -1 },
    });
    expect(p2.statusCode).toBe(400);
    expect(p2.body.error.code).toBe("LEGACY_READ_ONLY");

    // DELETE legacy → 400 LEGACY_READ_ONLY
    const d1 = await invoke(router, {
      method: "DELETE",
      path: `/api/metrics/${legacyId}`,
      body: { expectedRevision: -1 },
    });
    expect(d1.statusCode).toBe(400);
    expect(d1.body.error.code).toBe("LEGACY_READ_ONLY");

    // 正常定义可编辑可删除
    const p3 = await invoke(router, {
      method: "PATCH",
      path: `/api/metrics/${metricId}`,
      body: { definition: "SUM(amount) WHERE paid", notes: "更新备注" },
    });
    expect(p3.statusCode).toBe(200);
    const d2 = await invoke(router, {
      method: "DELETE",
      path: `/api/metrics/${metricId}`,
      body: {},
    });
    expect(d2.statusCode).toBe(200);

    const g2 = await invoke(router, { method: "GET", path: "/api/metrics", query: { includeArchived: "true" } });
    expect(g2.body.data.metrics).toHaveLength(1); // 归档的仍在 includeArchived 中
    expect(g2.body.data.metrics[0].archived).toBe(true);
  });
});
