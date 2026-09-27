/**
 * v0.13 T-1 — L2 即时注入测试（spec v0.13-EXECUTION_SPEC.md §3 / §6）
 *
 * 覆盖：
 * - L2-1 已交付清单：键内嵌 fingerprint、去重
 * - L2-2 提示类附注：触发四条件、预算逐行装填、三类内容（卡片 / 指标 / uncertain 警示）、
 *   开关与 env 解析、query_data 集成（首次附注 / 二次不重复 / get_table_card 联动去重）
 * - 不覆盖 L2-3 冲突类拦截（P1，未实施）
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, toSecurityConfig } from "../config.js";
import { PersistenceManager } from "../persistence.js";
import { SecurityChecker } from "../security.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { DataDictionaryManager } from "../hooks/data-dictionary.js";
import { QueryMemoryManager } from "../hooks/query-memory.js";
import { TableCardStore, computeTableSchemaFingerprint } from "../table-cards/store.js";
import {
  L2DeliveredState,
  L2_CHAR_BUDGET,
  buildL2Note,
  extractSqlTableNames,
  tableCardKey,
  metricKey,
  uncertainKey,
} from "../hooks/l2-injection.js";
import { createQueryDataTool } from "../tools/query-data.js";
import { createGetTableCardTool } from "../tools/get-table-card.js";
import type { ToolContext } from "../tools/tool-context.js";

// ============================================================================
// 纯函数：extractSqlTableNames
// ============================================================================

describe("extractSqlTableNames", () => {
  it("提取全部 FROM/JOIN 表名，去重并剥 schema 前缀", () => {
    expect(
      extractSqlTableNames("SELECT * FROM orders JOIN main.customers c ON o.cid = c.id LEFT JOIN orders o2 ON 1=1")
    ).toEqual(["orders", "customers"]);
  });

  it("大小写不敏感且支持引号标识符", () => {
    expect(extractSqlTableNames('select * from "Orders" left join `t2` on 1=1')).toEqual(["Orders", "t2"]);
  });

  it("子查询 FROM ( 不产生匹配", () => {
    expect(extractSqlTableNames("SELECT * FROM (SELECT 1) AS t WHERE x IN (SELECT y FROM real_table)")).toEqual([
      "real_table",
    ]);
  });
});

// ============================================================================
// 纯函数：buildL2Note
// ============================================================================

describe("buildL2Note", () => {
  const neverDelivered = () => false;

  it("装配卡片附注：summary + 前两条边界 + 键返回，预算内", () => {
    const note = buildL2Note({
      sql: "SELECT * FROM orders",
      userIntent: "按渠道统计订单数",
      tables: [
        {
          table: "orders",
          fingerprint: "fp1",
          card: { summary: "电商订单表", boundaries: ["仅样例数据", "不含退款单", "第三条边界"], stale: false },
        },
      ],
      metrics: [],
      delivered: neverDelivered,
    })!;
    expect(note.text).toContain("📋 语义附注");
    expect(note.text).toContain("【表卡片】orders: 电商订单表；边界: 仅样例数据；不含退款单");
    expect(note.text).not.toContain("第三条边界");
    expect(note.keys).toEqual([tableCardKey("orders", "fp1")]);
    expect(note.text.length).toBeLessThanOrEqual(L2_CHAR_BUDGET);
  });

  it("已交付的键不再装配（无内容时返回 null）", () => {
    const cardKey = tableCardKey("orders", "fp1");
    const note = buildL2Note({
      sql: "SELECT * FROM orders",
      userIntent: "按渠道统计订单数",
      tables: [{ table: "orders", fingerprint: "fp1", card: { summary: "电商订单表", boundaries: [] } }],
      metrics: [],
      delivered: (k) => k === cardKey,
    });
    expect(note).toBeNull();
  });

  it("user_intent 命中指标名（大小写不敏感）→ 附口径", () => {
    const note = buildL2Note({
      sql: "SELECT SUM(amount) FROM orders",
      userIntent: "看看 gmv 趋势",
      tables: [{ table: "orders", fingerprint: "fp1" }],
      metrics: [{ id: "m1", name: "GMV", definition: "已支付订单金额求和" }],
      delivered: neverDelivered,
    })!;
    expect(note.text).toContain("【指标口径】GMV = 已支付订单金额求和（SQL 涉及该指标时必须遵守）");
    expect(note.keys).toEqual([metricKey("m1")]);
  });

  it("user_intent 未命中指标名 → 不装配指标节", () => {
    const note = buildL2Note({
      sql: "SELECT SUM(amount) FROM orders",
      userIntent: "按渠道统计订单数",
      tables: [{ table: "orders", fingerprint: "fp1" }],
      metrics: [{ id: "m1", name: "GMV", definition: "已支付订单金额求和" }],
      delivered: neverDelivered,
    });
    expect(note).toBeNull();
  });

  it("SQL 触及 uncertain 列 → 字段警示", () => {
    const note = buildL2Note({
      sql: "SELECT channel, COUNT(*) FROM orders GROUP BY channel",
      userIntent: "按渠道统计",
      tables: [{ table: "orders", fingerprint: "fp1", uncertainColumns: ["channel"] }],
      metrics: [],
      delivered: neverDelivered,
    })!;
    expect(note.text).toContain("【字段警示】orders 字段 channel 语义未确认（uncertain）");
    expect(note.keys).toEqual([uncertainKey("orders", "fp1")]);
  });

  it("stale 卡片附过期提示", () => {
    const note = buildL2Note({
      sql: "SELECT * FROM orders",
      userIntent: "按渠道统计订单数",
      tables: [{ table: "orders", fingerprint: "fp1", card: { summary: "电商订单表", stale: true } }],
      metrics: [],
      delivered: neverDelivered,
    })!;
    expect(note.text).toContain("卡片已过期，建议 get_table_card 复核");
  });

  it("骨架卡（无 summary 无边界）跳过", () => {
    const note = buildL2Note({
      sql: "SELECT * FROM orders",
      userIntent: "按渠道统计订单数",
      tables: [{ table: "orders", fingerprint: "fp1", card: { summary: "", boundaries: [] } }],
      metrics: [],
      delivered: neverDelivered,
    });
    expect(note).toBeNull();
  });

  it("每轮最多覆盖 2 张表", () => {
    const tables = ["a", "b", "c"].map((t) => ({
      table: t,
      fingerprint: `fp_${t}`,
      card: { summary: `${t} 表`, boundaries: [] },
    }));
    const note = buildL2Note({
      sql: "SELECT * FROM a JOIN b ON 1=1 JOIN c ON 2=2",
      userIntent: "统计",
      tables,
      metrics: [],
      delivered: neverDelivered,
    })!;
    expect(note.text).toContain("【表卡片】a: a 表");
    expect(note.text).toContain("【表卡片】b: b 表");
    expect(note.text).not.toContain("【表卡片】c:");
    expect(note.keys).toHaveLength(2);
  });

  it("超预算的行整行放弃，其键不进入返回（下次仍可交付）", () => {
    const longSummary = "长".repeat(900);
    const note = buildL2Note({
      sql: "SELECT * FROM big JOIN small ON 1=1",
      userIntent: "统计",
      tables: [
        { table: "big", fingerprint: "fp_big", card: { summary: longSummary, boundaries: [] } },
        { table: "small", fingerprint: "fp_small", card: { summary: "小表", boundaries: [] } },
      ],
      metrics: [],
      delivered: neverDelivered,
    })!;
    expect(note.text.length).toBeLessThanOrEqual(L2_CHAR_BUDGET);
    expect(note.text).not.toContain(longSummary);
    expect(note.keys).toEqual([tableCardKey("small", "fp_small")]);
  });
});

// ============================================================================
// 配置：l2InjectionEnabled（L2-1）
// ============================================================================

describe("l2InjectionEnabled config", () => {
  it("默认开启", () => {
    const t = mkdtempSync(join(tmpdir(), "l2-cfg-"));
    try {
      expect(loadConfig({ cwd: t }).l2InjectionEnabled).toBe(true);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("env off / false / 0 关闭", () => {
    const t = mkdtempSync(join(tmpdir(), "l2-cfg-"));
    try {
      for (const value of ["off", "false", "0"]) {
        vi.stubEnv("PI_DATA_AGENT_L2_INJECTION", value);
        expect(loadConfig({ cwd: t }).l2InjectionEnabled).toBe(false);
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("env 1 / true 开启", () => {
    const t = mkdtempSync(join(tmpdir(), "l2-cfg-"));
    try {
      for (const value of ["1", "true", "on"]) {
        vi.stubEnv("PI_DATA_AGENT_L2_INJECTION", value);
        expect(loadConfig({ cwd: t }).l2InjectionEnabled).toBe(true);
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(t, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 集成：query_data / get_table_card × L2（真实引擎 + 临时目录）
// ============================================================================

describe("L2 integration", () => {
  let tmp: string;
  let config: ReturnType<typeof loadConfig>;
  let persistence: PersistenceManager;
  let security: SecurityChecker;
  let engine: DuckDBEngine;
  let tableCards: TableCardStore;
  let dataDictionary: DataDictionaryManager;
  let queryMemory: QueryMemoryManager;
  let l2State: L2DeliveredState;
  let toolContext: ToolContext;

  const mockCtx = {
    ui: null,
    sessionManager: { getBranch: () => [], appendEntry: () => {} },
  } as any;

  const QUERY_ARGS = {
    sql: "SELECT channel, COUNT(*) AS cnt FROM orders GROUP BY channel ORDER BY channel",
    user_intent: "按渠道统计订单数",
  };

  beforeAll(async () => {
    // 隔离宿主环境变量对临时 cwd 派生路径的覆盖（同 core-entry.test.ts 做法）
    vi.stubEnv("PI_DATA_AGENT_CWD", undefined);
    vi.stubEnv("PI_DATA_AGENT_DB_PATH", undefined);
    vi.stubEnv("PI_DATA_AGENT_ALLOWED_PATHS", undefined);
    vi.stubEnv("PI_DATA_AGENT_L2_INJECTION", undefined);

    tmp = mkdtempSync(join(tmpdir(), "l2-integration-"));
    config = loadConfig({ cwd: tmp });
    persistence = new PersistenceManager(config.globalConfigDir, config.projectConfigDir);
    security = new SecurityChecker(toSecurityConfig(config));
    engine = new DuckDBEngine({
      dbPath: config.dbPath,
      previewLimit: config.previewLimit,
      outputDir: config.outputDir,
    });
    await engine.init();
    await engine.exec("CREATE TABLE orders (order_id INTEGER, channel VARCHAR, amount DECIMAL(10,2))");
    await engine.exec("INSERT INTO orders VALUES (1, 'app', 10.0), (2, 'web', 20.0), (3, 'app', 30.0)");

    persistence.saveDataDictionary([], "project");
    persistence.saveQueryMemory({ maxEntries: 5, entries: [] }, "project");
    dataDictionary = new DataDictionaryManager(persistence);
    queryMemory = new QueryMemoryManager(persistence, config.maxQueryMemoryEntries);
    tableCards = new TableCardStore(config.projectConfigDir);
    tableCards.put(
      "orders",
      { summary: "电商订单表", boundaries: ["仅含 2026-06 样例数据", "不含退款单"] },
      tableCards.list().revision
    );
  });

  beforeEach(() => {
    l2State = new L2DeliveredState();
    toolContext = {
      engine,
      security,
      persistence,
      cwd: config.cwd,
      config,
      dataDictionary,
      queryMemory,
      tableCards,
      l2State,
    };
  });

  afterAll(async () => {
    try {
      await engine.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it("L2-2: 首次查询附注前置，二次查询不重复", async () => {
    const tool = createQueryDataTool({ getRuntime: () => toolContext });
    const r1 = await tool.execute("t1", QUERY_ARGS, undefined, undefined, mockCtx);
    const text1 = (r1.content[0] as any).text as string;
    expect((r1.details as any).l2NoteProvided).toBe(true);
    expect(text1.startsWith("📋 语义附注")).toBe(true);
    expect(text1).toContain("【表卡片】orders: 电商订单表；边界: 仅含 2026-06 样例数据；不含退款单");
    // 查询结果本体仍在附注之后
    expect(text1).toContain("channel");
    expect(l2State.size).toBeGreaterThanOrEqual(1);

    const r2 = await tool.execute("t2", QUERY_ARGS, undefined, undefined, mockCtx);
    expect((r2.details as any).l2NoteProvided).toBe(false);
    expect(((r2.content[0] as any).text as string).startsWith("📋 语义附注")).toBe(false);
  });

  it("L2-4: get_table_card 成功后写已交付清单，同表查询不再附卡片", async () => {
    const metricsPath = join(config.projectConfigDir, "metrics.json");
    writeFileSync(
      metricsPath,
      JSON.stringify([
        { id: "m_gmv", name: "GMV", definition: "已支付订单金额求和", datasets: ["orders"], updatedAt: new Date().toISOString() },
      ])
    );
    try {
      const cardTool = createGetTableCardTool({ getRuntime: () => toolContext });
      await cardTool.execute("t3", { table_name: "orders" }, undefined, undefined, mockCtx);

      const fingerprint = computeTableSchemaFingerprint("orders", await engine.getSchema("orders"));
      expect(l2State.has(tableCardKey("orders", fingerprint))).toBe(true);
      expect(l2State.has(metricKey("m_gmv"))).toBe(true);

      const tool = createQueryDataTool({ getRuntime: () => toolContext });
      const r = await tool.execute(
        "t4",
        { ...QUERY_ARGS, user_intent: "按渠道统计订单数，GMV 口径是多少" },
        undefined,
        undefined,
        mockCtx
      );
      // 卡片与指标均已由 get_table_card 交付 → 本次无附注
      expect((r.details as any).l2NoteProvided).toBe(false);
    } finally {
      rmSync(metricsPath, { force: true });
    }
  });

  it("开关关闭时完全静默", async () => {
    config.l2InjectionEnabled = false;
    try {
      const tool = createQueryDataTool({ getRuntime: () => toolContext });
      const r = await tool.execute("t5", QUERY_ARGS, undefined, undefined, mockCtx);
      expect((r.details as any).l2NoteProvided).toBe(false);
      expect(((r.content[0] as any).text as string).startsWith("📋 语义附注")).toBe(false);
    } finally {
      config.l2InjectionEnabled = true;
    }
  });

  it("SQL 触及 uncertain 字典列 → 附字段警示", async () => {
    const fingerprint = computeTableSchemaFingerprint("orders", await engine.getSchema("orders"));
    persistence.saveDataDictionary(
      [
        {
          tableName: "orders",
          columns: [
            { name: "channel", type: "VARCHAR", inferredMeaning: "渠道来源", status: "uncertain" },
          ],
          generatedAt: new Date().toISOString(),
          status: "ai-guessed",
        },
      ] as any,
      "project"
    );
    try {
      const tool = createQueryDataTool({ getRuntime: () => toolContext });
      const r = await tool.execute("t6", QUERY_ARGS, undefined, undefined, mockCtx);
      const text = (r.content[0] as any).text as string;
      expect(text).toContain("【字段警示】orders 字段 channel 语义未确认（uncertain）");
      expect(l2State.has(uncertainKey("orders", fingerprint))).toBe(true);
    } finally {
      persistence.saveDataDictionary([], "project");
    }
  });
});
