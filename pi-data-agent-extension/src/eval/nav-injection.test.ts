/**
 * v0.10 A-4 — 导航层注入 + get_table_card 三源聚合验收测试（vitest）
 *
 * 覆盖（规范 §10.2 nav-injection.test.ts）：
 * - 导航渲染格式：有卡片 → `表名 · 标签 · 一句话summary`；无卡片退化为 N rows, M columns
 * - 预算截断：多表（超 NAV_CHAR_BUDGET）→ 折叠为分类标签 + get_table_card 下钻提示，总长 ≤ 预算
 * - get_table_card 三源聚合拼装：【表卡片】【相关指标口径】【字段业务含义】
 *   含排序（已修正 > 已确认 > AI推测 > 不确定）与数量上限（指标 ≤5、字段 ≤20）
 * - 兜底：无卡片 → schema 骨架注明"待补充"；无字典 → 提示 Dashboard AI 推断；表不存在 → 可用错误
 * - pinned 小节与指标小节渲染（L0 注入的 A-5/A-6 部分）
 *
 * 隔离模式：mkdtempSync 临时目录 + 独立 DuckDB 实例。
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  renderNavContext,
  renderNavLine,
  renderPinnedSection,
  renderMetricsSection,
  truncateToBudget,
  extractTableNameFromSql,
  NAV_CHAR_BUDGET,
  METRICS_INJECTION_LIMIT,
} from "../navigation/nav-context.js";
import type { NavTableInfo } from "../navigation/nav-context.js";
import { createGetTableCardTool } from "../tools/get-table-card.js";
import type { ToolContext } from "../tools/tool-context.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { PersistenceManager } from "../persistence.js";
import { TableCardStore } from "../table-cards/store.js";
import type { MetricEntry } from "../dashboard/types.js";

let tmpDir: string | null = null;
let engine: DuckDBEngine | null = null;

function makeTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-nav-injection-test-"));
  return tmpDir;
}

/** 构造 25 列的 orders 表 + 3 列的 users 表 */
async function setupEngine(): Promise<DuckDBEngine> {
  const dir = makeTmpDir();
  engine = new DuckDBEngine({
    dbPath: join(dir, "session.duckdb"),
    previewLimit: 100,
    outputDir: join(dir, "output"),
  });
  await engine.init();

  const orderCols = Array.from({ length: 25 }, (_, i) => `col_${String(i).padStart(2, "0")} INTEGER`).join(", ");
  await engine.exec(`CREATE OR REPLACE TABLE orders (${orderCols})`);
  await engine.exec("CREATE OR REPLACE TABLE users (user_id INTEGER, name VARCHAR, city VARCHAR)");
  return engine;
}

function makePersistence(dir: string): PersistenceManager {
  return new PersistenceManager(join(dir, "global"), join(dir, ".pi-data-agent"));
}

/** 写入 metrics.json（RevisionedData 包装），返回写入的条目 */
function writeMetrics(projectDir: string, metrics: MetricEntry[]): void {
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "metrics.json"),
    JSON.stringify({ data: metrics, revision: 7, updatedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
}

function makeMetric(partial: Partial<MetricEntry> & { id: string; name: string }): MetricEntry {
  return {
    definition: `${partial.name} 的计算规则`,
    datasets: [],
    status: "user-confirmed",
    source: "user",
    revision: 0,
    updatedAt: new Date().toISOString(),
    archived: false,
    ...partial,
  } as MetricEntry;
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

// ============================================================================
// L0 导航渲染（纯函数）
// ============================================================================

describe("A-4 导航渲染", () => {
  const t = (name: string, rowCount = 10, columnCount = 5): NavTableInfo => ({ name, rowCount, columnCount });

  it("有卡片：每表一行 `表名 · 标签 · 一句话summary`", () => {
    const cards = new Map([["orders", { summary: "支付订单明细表", tags: ["订单", "交易"] }]]);
    expect(renderNavLine(t("orders"), cards.get("orders"))).toBe("- orders · 订单/交易 · 支付订单明细表");
  });

  it("无卡片退化：N 行 M 列展示，不报错；stale 卡片附提醒", () => {
    expect(renderNavLine(t("raw_logs", 1200, 42))).toBe("- raw_logs: 1200 rows, 42 columns");
    const staleCards = new Map([["orders", { summary: "订单表", tags: [], stale: true }]]);
    expect(renderNavLine(t("orders"), staleCards.get("orders"))).toContain("结构已变化");
  });

  it("预算截断：大量长 summary 表 → 折叠为分类标签 + 工具下钻提示，总长 ≤ 预算", () => {
    const tables: NavTableInfo[] = Array.from({ length: 40 }, (_, i) => t(`table_${i}`));
    const cards = new Map<string, { summary: string; tags: string[] }>();
    for (let i = 0; i < 40; i++) {
      // 每个 summary ~90 字符，40 张表远超 1600 字符预算
      cards.set(`table_${i}`, { summary: `这是第 ${i} 张表的很长的一句话摘要用于撑爆导航预算`.repeat(3), tags: [`分类${i % 6}`] });
    }
    const nav = renderNavContext({ tables, cards });
    expect(nav.length).toBeLessThanOrEqual(NAV_CHAR_BUDGET);
    expect(nav).toContain("get_table_card");
    expect(nav).toContain("分类"); // 标签仍在
    expect(nav).not.toContain("table_0 ·"); // 明细行已折叠
  });

  it("正常规模：逐行渲染不折叠；pinned 与指标小节按格式拼接", () => {
    const tables = [t("orders"), t("users")];
    const cards = new Map([["orders", { summary: "支付订单明细表", tags: ["订单"] }]]);
    const nav = renderNavContext({
      tables,
      cards,
      pinned: [{ naturalLanguageQuery: "上个月 GMV 是多少", sql: "SELECT SUM(amount) FROM orders" }],
      metrics: [{ name: "GMV", definition: "SUM(amount) WHERE status='paid'", updatedAt: "2026-01-01" }],
    });
    expect(nav).toContain("- orders · 订单 · 支付订单明细表");
    expect(nav).toContain("- users: 10 rows, 5 columns");
    expect(nav).toContain('- "上个月 GMV 是多少" (orders)');
    expect(nav).toContain("- GMV = SUM(amount) WHERE status='paid'");
    expect(nav.length).toBeLessThanOrEqual(NAV_CHAR_BUDGET);
  });

  it("空表清单不注入导航段", () => {
    expect(renderNavContext({ tables: [], cards: new Map() })).toBe("");
  });

  it("pinned 上限 10 条；SQL 反解表名失败时显示未知表占位", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      naturalLanguageQuery: `问题 ${i}`,
      sql: `SELECT 1`, // 无法反解表名
    }));
    const section = renderPinnedSection(many);
    expect(section.match(/^- "/gm)?.length).toBe(10);

    const named = renderPinnedSection([{ naturalLanguageQuery: "查订单", sql: 'SELECT * FROM "orders" WHERE id=1' }]);
    expect(named).toContain("(orders)");
    expect(named).not.toContain("(未知表)");
    // schema 前缀剥离取最后一段表名
    expect(extractTableNameFromSql("SELECT * FROM db.orders JOIN users ON 1=1")).toBe("orders");
  });

  it("指标注入：全量 ≤20 条，超出按最近使用截断并附省略提示", () => {
    const metrics = Array.from({ length: 25 }, (_, i) => ({
      name: `指标${i}`,
      definition: `定义 ${i}`,
      updatedAt: new Date(Date.now() - i * 1000).toISOString(), // i 越小越新
    }));
    const section = renderMetricsSection(metrics);
    const lines = section.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBe(METRICS_INJECTION_LIMIT);
    expect(lines[0]).toContain("指标0"); // 最近使用的在前
    expect(section).toContain("另有 5 条指标未列出");

    // 少于上限时不加省略提示
    const few = renderMetricsSection(metrics.slice(0, 3));
    expect(few.split("\n").filter((l) => l.startsWith("- ")).length).toBe(3);
    expect(few).not.toContain("未列出");
  });

  it("truncateToBudget 截断后不超过预算且带省略标记", () => {
    const out = truncateToBudget("a".repeat(2000), 100);
    expect(out.length).toBe(100);
    expect(out.endsWith("…")).toBe(true);
    expect(truncateToBudget("short", 100)).toBe("short");
  });
});

// ============================================================================
// get_table_card 三源聚合
// ============================================================================

describe("A-4 get_table_card 工具", () => {
  async function setupFull(): Promise<{ ctx: ToolContext; store: TableCardStore; dir: string }> {
    const dir = makeTmpDir();
    const eng = await setupEngine();
    const persistence = makePersistence(dir);
    const projectDir = join(dir, ".pi-data-agent");

    // 源 1：表卡片（orders 有，users 无）
    const store = new TableCardStore(projectDir);
    store.put("orders", {
      summary: "支付订单明细表",
      suitableFor: ["GMV 分析"],
      boundaries: ["不含已取消订单"],
      whenToUse: ["销售额类问题"],
      tags: ["订单", "交易"],
    }, -1);

    // 源 2：metrics.json —— 6 条关联 orders（验证 ≤5 截断）、1 条关联 users、1 条 archived、1 条 legacy
    writeMetrics(projectDir, [
      makeMetric({ id: "m1", name: "GMV", definition: "SUM(amount) WHERE status='paid'", datasets: ["orders"] }),
      makeMetric({ id: "m2", name: "订单量", definition: "COUNT(DISTINCT order_id)", datasets: ["orders"] }),
      makeMetric({ id: "m3", name: "客单价", definition: "GMV / 订单量", datasets: ["orders"] }),
      makeMetric({ id: "m4", name: "复购率", definition: "多单用户/总用户", datasets: ["orders"] }),
      makeMetric({ id: "m5", name: "退款率", definition: "退款额/GMV", datasets: ["orders"] }),
      makeMetric({ id: "m6", name: "第六条不应出现", definition: "x", datasets: ["orders"] }),
      makeMetric({ id: "m7", name: "活跃用户数", definition: "COUNT(DISTINCT user_id)", datasets: ["users"] }),
      makeMetric({ id: "m8", name: "已归档指标", definition: "x", datasets: ["orders"], archived: true }),
      makeMetric({ id: "m9", name: "历史问题口径", definition: "旧定义", question: "旧问题？", datasets: ["orders"] }),
    ]);

    // 源 3：字段字典 —— orders 25 列，状态循环 已修正/已确认/AI推测 ×8 + 不确定 ×1
    const statuses = ["user-corrected", "user-confirmed", "ai-guessed"] as const;
    persistence.saveDataDictionary([
      {
        tableName: "orders",
        generatedAt: new Date().toISOString(),
        status: "ai-guessed",
        columns: Array.from({ length: 25 }, (_, i) => ({
          name: `col_${String(i).padStart(2, "0")}`,
          type: "INTEGER",
          inferredMeaning: `列 ${i} 推断含义`,
          userMeaning: i % 3 === 0 ? `列 ${i} 用户修正含义` : undefined,
          status: i < 24 ? statuses[i % 3] : "uncertain",
        })),
      },
      // users 故意不给字典（测试空字典兜底）
    ], "project");

    const ctx = {
      engine: eng,
      security: {},
      persistence,
      cwd: dir,
      config: { projectConfigDir: projectDir },
      queryMemory: undefined,
      tableCards: store,
    } as unknown as ToolContext;
    return { ctx, store, dir };
  }

  function executeTool(ctx: ToolContext, tableName: string) {
    const tool = createGetTableCardTool({ getRuntime: () => ctx });
    return tool.execute("call-1", { table_name: tableName }, undefined, undefined, {} as never) as Promise<{
      content: Array<{ type: string; text: string }>;
      details: Record<string, unknown>;
    }>;
  }

  it("三源聚合：【表卡片】+【相关指标口径】(≤5 条)+【字段业务含义】(排序 + ≤20)", async () => {
    const { ctx } = await setupFull();
    const result = await executeTool(ctx, "orders");
    const text = result.content[0].text;

    // 固定模板三节
    expect(text).toContain("【表卡片】");
    expect(text).toContain("【相关指标口径】");
    expect(text).toContain("【字段业务含义】");

    // 源 1：存储卡内容
    expect(text).toContain("支付订单明细表");
    expect(text).toContain("不含已取消订单");
    expect(text).toContain("AI 起草（未经用户确认）");

    // 源 2：datasets 关联过滤 + ≤5 截断 + 排除 archived/legacy/无关表
    expect(text).toContain("- GMV: SUM(amount) WHERE status='paid'");
    expect(text).toContain("退款率");
    expect(text).not.toContain("第六条不应出现");
    expect(text).not.toContain("已归档指标");
    expect(text).not.toContain("历史问题口径");
    expect(text).not.toContain("活跃用户数"); // 关联的是 users 不是 orders
    expect(result.details.relatedMetrics).toHaveLength(5);

    // 源 3：可信度排序（已修正最前）+ 上限 20（25 列中最后 5 个含不确定的被隐藏）
    const fieldSection = text.split("【字段业务含义】")[1];
    const fieldLines = fieldSection.split("\n").filter((l) => l.trim().startsWith("- ["));
    expect(fieldLines.length).toBe(20);
    expect(fieldLines[0]).toContain("[已修正]");
    expect(fieldLines[0]).toContain("col_00");
    expect(fieldLines[0]).toContain("列 0 用户修正含义");
    expect(fieldLines.join("\n")).not.toContain("[不确定]");
    expect(fieldSection).toContain("其余 5 个字段未列出");
    // AI推测标注未确认警告
    expect(fieldLines.some((l) => l.includes("[AI推测]") && l.includes("(未确认)"))).toBe(true);
  });

  it("无卡片退化：schema 骨架注明待补充；无字典提示可在 Dashboard 跑 AI 推断", async () => {
    const { ctx } = await setupFull();
    const result = await executeTool(ctx, "users");
    const text = result.content[0].text;

    expect(result.details.cardSource).toBe("skeleton");
    expect(text).toContain("待补充——尚无表卡片");
    expect(text).toContain("user_id");
    // users 有 1 条关联指标（活跃用户数），但无字典 → 空字典兜底文案
    expect(text).toContain("- 活跃用户数: COUNT(DISTINCT user_id)");
    expect(text).toContain("暂无该表的字段字典");
    expect(text).toContain("AI 推断");
  });

  it("表不存在：返回可用错误并列出当前可用表", async () => {
    const { ctx } = await setupFull();
    const result = await executeTool(ctx, "nope");
    const text = result.content[0].text;
    expect(text).toContain('Table "nope" not found');
    expect(text).toContain("- orders");
    expect(text).toContain("- users");
    expect(result.details.error).toBe("table_not_found");
  });

  it("引擎不可用：返回错误而不是抛异常", async () => {
    const dir = makeTmpDir();
    const ctx = {
      engine: null,
      persistence: makePersistence(dir),
      cwd: dir,
      config: { projectConfigDir: join(dir, ".pi-data-agent") },
    } as unknown as ToolContext;
    const result = await executeTool(ctx, "orders");
    expect(result.content[0].text).toContain("Error: DuckDB engine not available.");
  });

  it("stale 卡片在工具返回中标注过期提醒", async () => {
    const { ctx, store } = await setupFull();
    store.markStaleIfChanged("orders", "different-fingerprint");
    const result = await executeTool(ctx, "orders");
    expect(result.content[0].text).toContain("已过期");
  });
});
