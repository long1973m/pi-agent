/**
 * v0.13 T-1 — PM 分析模板测试（spec v0.13-EXECUTION_SPEC.md §4 / §6；golden 数据集答案精确已知）
 *
 * 覆盖：TPL-1 骨架（参数校验 / 字典联动 / 表登记 / 安全 / 审计）、TPL-2 funnel、TPL-3 cohort、
 * AB-2 共用 sanity 组件（funnel/cohort 规则）、F4 HUGEINT 类型映射修复回归。
 * ab_test 模板属阶段三（AB-1），不在本文件范围。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, toSecurityConfig } from "../config.js";
import { PersistenceManager } from "../persistence.js";
import { SecurityChecker } from "../security.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { DataDictionaryManager } from "../hooks/data-dictionary.js";
import { QueryMemoryManager } from "../hooks/query-memory.js";
import { AuditLogManager } from "../audit-log.js";
import { createRunAnalysisTemplateTool } from "../tools/run-analysis-template.js";
import { buildFunnelSql } from "../analysis/pm-templates.js";
import type { ToolContext } from "../tools/tool-context.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const FUNNEL_ARGS = {
  template: "funnel",
  table: "funnel_known",
  user_intent: "看渠道转化漏斗",
  params: {
    steps: [
      { label: "访问", condition: "channel IS NOT NULL" },
      { label: "大额", condition: "amount >= 50" },
      { label: "有券", condition: "has_coupon = true" },
    ],
    user_key: "user_id",
  },
};

const COHORT_ARGS = {
  template: "cohort",
  table: "cohort_known",
  user_intent: "看月度留存",
  params: {
    user_key: "user_id",
    activity_time: "activity_date",
    period: "month",
    activity_condition: "kind = 'purchase'",
    lookback: 12,
  },
};

describe("PM analysis templates", () => {
  let tmp: string;
  let config: ReturnType<typeof loadConfig>;
  let persistence: PersistenceManager;
  let security: SecurityChecker;
  let engine: DuckDBEngine;
  let dataDictionary: DataDictionaryManager;
  let queryMemory: QueryMemoryManager;
  let auditLog: AuditLogManager;
  let toolContext: ToolContext;

  const mockCtx = { ui: null, sessionManager: { getBranch: () => [], appendEntry: () => {} } } as any;

  beforeAll(async () => {
    vi.stubEnv("PI_DATA_AGENT_CWD", undefined);
    vi.stubEnv("PI_DATA_AGENT_DB_PATH", undefined);
    vi.stubEnv("PI_DATA_AGENT_ALLOWED_PATHS", undefined);

    tmp = mkdtempSync(join(tmpdir(), "pm-templates-"));
    config = loadConfig({ cwd: tmp });
    persistence = new PersistenceManager(config.globalConfigDir, config.projectConfigDir);
    security = new SecurityChecker(toSecurityConfig(config));
    engine = new DuckDBEngine({
      dbPath: config.dbPath,
      previewLimit: config.previewLimit,
      outputDir: config.outputDir,
    });
    await engine.init();

    await engine.exec(
      `CREATE TABLE funnel_known AS SELECT * FROM read_csv_auto('${join(FIXTURES, "funnel-known.csv")}')`
    );
    await engine.exec(
      `CREATE TABLE cohort_known AS SELECT * FROM read_csv_auto('${join(FIXTURES, "cohort-known.csv")}')`
    );
    // 字典联动专用表（与 golden 表隔离，避免 uncertain 标记污染其他用例）
    await engine.exec(`CREATE TABLE funnel_known2 AS SELECT * FROM funnel_known`);
    // AB golden 数据（答案精确已知，见 spec §6.1）
    await engine.exec(
      `CREATE TABLE ab_known AS SELECT * FROM read_csv_auto('${join(FIXTURES, "ab-known.csv")}')`
    );
    await engine.exec(
      `CREATE TABLE ab_small AS SELECT * FROM read_csv_auto('${join(FIXTURES, "ab-small.csv")}')`
    );
    await engine.exec(
      `CREATE TABLE ab_simpson AS SELECT * FROM read_csv_auto('${join(FIXTURES, "ab-simpson.csv")}')`
    );
    await engine.exec(
      `CREATE TABLE ab_three AS SELECT * FROM (VALUES ('u1','c1',true),('u2','c1',false),('u3','c2',true),('u4','c3',false)) AS t(user_id, variant, converted)`
    );
    await engine.exec(
      `CREATE TABLE ab_edge AS SELECT * FROM (VALUES ${Array.from({ length: 10 }, (_, i) => `('e${i + 1}','control',${i < 5})`).join(",")}, ${Array.from({ length: 10 }, (_, i) => `('f${i + 1}','treatment',true)`).join(",")}) AS t(user_id, variant, converted)`
    );

    dataDictionary = new DataDictionaryManager(persistence);
    queryMemory = new QueryMemoryManager(persistence, config.maxQueryMemoryEntries);
    auditLog = new AuditLogManager(config.projectConfigDir);

    toolContext = {
      engine,
      security,
      persistence,
      cwd: config.cwd,
      config,
      dataDictionary,
      queryMemory,
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

  const run = async (args: Record<string, unknown>) => {
    const tool = createRunAnalysisTemplateTool({ getRuntime: () => toolContext });
    return tool.execute("s0", args as any, undefined, undefined, mockCtx);
  };

  // ==========================================================================
  // TPL-2 funnel
  // ==========================================================================

  it("TPL-2 golden：三步 10/6/3，步转化 60%/50%，累计 100%/60%/30%", async () => {
    const r = await run(FUNNEL_ARGS);
    const details = r.details as any;
    expect(details.error).toBeUndefined();
    expect(details.steps.map((s: any) => s.users)).toEqual([10, 6, 3]);
    expect(details.steps.map((s: any) => s.stepConversionPct)).toEqual([null, 60, 50]);
    expect(details.steps.map((s: any) => s.totalConversionPct)).toEqual([100, 60, 30]);
    expect(details.warnings).toEqual([]);
    expect((r.content[0] as any).text).toContain("funnel 漏斗分析");
    expect((r.content[0] as any).text).toContain("方法与局限");
  });

  it("TPL-2 窗口：window_days=60 排除 2026-01 的两行 → 第一步 8 人", async () => {
    const r = await run({
      ...FUNNEL_ARGS,
      params: { ...FUNNEL_ARGS.params, time_column: "order_date", window_days: 60 },
    });
    const details = r.details as any;
    expect(details.steps.map((s: any) => s.users)).toEqual([8, 6, 3]);
  });

  it("TPL-2 参数错误：步数不足 / 过多 / 缺 user_key（含修正指引）", async () => {
    const one = await run({ ...FUNNEL_ARGS, params: { steps: [{ label: "a", condition: "1=1" }], user_key: "user_id" } });
    expect((one.details as any).error).toBe("invalid_params");
    expect((one.details as any).param).toBe("steps");

    const nine = await run({
      ...FUNNEL_ARGS,
      params: { steps: Array.from({ length: 9 }, (_, i) => ({ label: `s${i}`, condition: "1=1" })), user_key: "user_id" },
    });
    expect((nine.details as any).error).toBe("invalid_params");

    const noKey = await run({ ...FUNNEL_ARGS, params: { steps: FUNNEL_ARGS.params.steps } });
    expect((noKey.details as any).param).toBe("user_key");
  });

  it("TPL-1 列缺失：user_key 指向不存在列 → 结构化错误（预校验，含可用列清单）", async () => {
    const r = await run({ ...FUNNEL_ARGS, params: { ...FUNNEL_ARGS.params, user_key: "no_such_col" } });
    const details = r.details as any;
    expect(details.error).toBe("missing_column");
    expect(details.missingColumns).toEqual(["no_such_col"]);
    expect(details.availableColumns).toContain("user_id");
    // 不产出统计叙述
    expect((r.content[0] as any).text).not.toContain("漏斗分析");
  });

  it("TPL-1 只读红线：条件注入写语句成分 → 执行失败且表完好", async () => {
    const r = await run({
      ...FUNNEL_ARGS,
      params: {
        steps: [
          { label: "a", condition: "channel IS NOT NULL); DROP TABLE funnel_known; --" },
          { label: "b", condition: "1=1" },
        ],
        user_key: "user_id",
      },
    });
    // 无论被安全拦截还是执行报错，绝不允许成功返回 + 表必须仍在
    const tables = await engine.getTables();
    expect(tables).toContain("funnel_known");
    const text = (r.content[0] as any).text as string;
    expect(text.startsWith("📊")).toBe(false);
  });

  it("TPL-1 字典联动（fail-closed）：uncertain 列被条件触及 → 拒绝执行", async () => {
    await dataDictionary.ensureDictionary("funnel_known2", engine);
    dataDictionary.markColumnsUncertain("funnel_known2", ["channel"]);
    const r = await run({
      ...FUNNEL_ARGS,
      table: "funnel_known2",
      params: {
        steps: [
          { label: "a", condition: "channel IS NOT NULL" },
          { label: "b", condition: "amount >= 50" },
        ],
        user_key: "user_id",
      },
    });
    expect((r.details as any).error).toBe("uncertain_columns_blocked");
    expect((r.details as any).uncertainColumns).toEqual(["channel"]);
  });

  it("TPL-1 字典联动：ai-guessed 映射列 → 不阻断，dictionaryFlags 标记", async () => {
    await dataDictionary.ensureDictionary("funnel_known2", engine);
    const r = await run({
      ...FUNNEL_ARGS,
      table: "funnel_known2",
      params: {
        steps: [
          { label: "a", condition: "amount >= 50" },
          { label: "b", condition: "has_coupon = true" },
        ],
        user_key: "user_id",
      },
    });
    const details = r.details as any;
    expect(details.error).toBeUndefined();
    expect(details.dictionaryFlags.aiGuessedColumns).toContain("user_id");
  });

  // ==========================================================================
  // TPL-3 cohort
  // ==========================================================================

  it("TPL-3 golden（含活动条件）：两群 100/60/30% 与 100/50%，均值 55%/30%", async () => {
    const r = await run(COHORT_ARGS);
    const details = r.details as any;
    expect(details.error).toBeUndefined();
    expect(details.cohorts).toHaveLength(2);

    const jan = details.cohorts[0];
    expect(jan.cohort).toBe("2026-01-01");
    expect(jan.size).toBe(10);
    expect(jan.offsets.map((o: any) => o.retentionPct)).toEqual([100, 60, 30]);

    const feb = details.cohorts[1];
    expect(feb.cohort).toBe("2026-02-01");
    expect(feb.size).toBe(8);
    expect(feb.offsets.map((o: any) => o.retentionPct)).toEqual([100, 50]);

    expect(details.averageRetentionPct).toEqual([
      { offset: 0, avgPct: 100 },
      { offset: 1, avgPct: 55 },
      { offset: 2, avgPct: 30 },
    ]);
    expect(details.warnings).toEqual([]);
    expect((r.content[0] as any).text).toContain("方法与局限");
  });

  it("TPL-3 无活动条件时 browse 噪声计入（验证 activity_condition 的作用）", async () => {
    const r = await run({
      ...COHORT_ARGS,
      params: { ...COHORT_ARGS.params, activity_condition: undefined },
    });
    const details = r.details as any;
    const jan = details.cohorts.find((c: any) => c.cohort === "2026-01-01");
    // u9 的 browse 行计入 → off1 6→7；u7 的 browse 行计入 → off2 3→4
    expect(jan.offsets.find((o: any) => o.offset === 1).retained).toBe(7);
    expect(jan.offsets.find((o: any) => o.offset === 2).retained).toBe(4);
  });

  it("TPL-3 lookback=1 截断偏移（offset2 不出现）", async () => {
    const r = await run({ ...COHORT_ARGS, params: { ...COHORT_ARGS.params, lookback: 1 } });
    const details = r.details as any;
    for (const c of details.cohorts) {
      expect(Math.max(...c.offsets.map((o: any) => o.offset))).toBeLessThanOrEqual(1);
    }
    expect(details.averageRetentionPct.map((a: any) => a.offset)).toEqual([0, 1]);
  });

  it("TPL-3 参数错误：period 非法 / lookback 超限 / 缺 activity_time", async () => {
    const badPeriod = await run({ ...COHORT_ARGS, params: { ...COHORT_ARGS.params, period: "day" } });
    expect((badPeriod.details as any).param).toBe("period");

    const badLookback = await run({ ...COHORT_ARGS, params: { ...COHORT_ARGS.params, lookback: 25 } });
    expect((badLookback.details as any).param).toBe("lookback");

    const noTime = await run({ ...COHORT_ARGS, params: { user_key: "user_id", period: "month" } });
    expect((noTime.details as any).param).toBe("activity_time");
  });

  // ==========================================================================
  // TPL-1 骨架
  // ==========================================================================

  it("未知模板 → 结构化错误（指引可用模板）", async () => {
    const r = await run({ ...FUNNEL_ARGS, template: "cohort_v2" });
    expect((r.details as any).error).toBe("unknown_template");
    expect((r.content[0] as any).text).toContain("funnel、cohort、ab_test");
  });

  it("表未登记 → 结构化错误（含可用表清单）", async () => {
    const r = await run({ ...FUNNEL_ARGS, table: "no_such_table" });
    expect((r.details as any).error).toBe("table_not_registered");
    expect((r.details as any).availableTables).toContain("funnel_known");
  });

  it("审计：run_analysis_template 进入白名单并产出摘要", () => {
    auditLog.recordStart("tc1", "run_analysis_template", {
      template: "funnel",
      table: "funnel_known",
      user_intent: "看渠道转化漏斗",
    });
    auditLog.recordEnd({ toolCallId: "tc1", result: { details: {} }, isError: false });
    const recent = auditLog.getRecent(10);
    const entry = recent.find((e) => e.toolCallId === "tc1");
    expect(entry).toBeDefined();
    expect(entry!.summary).toContain("funnel on funnel_known");
    expect(entry!.result).toBe("success");
  });

  it("F4 回归：HUGEINT 列类型正确映射（不再退化为 VARCHAR）", async () => {
    await engine.exec(`CREATE TABLE huge_t AS SELECT '170141183460469231731687303715884105727'::HUGEINT AS h`);
    const schema = await engine.getSchema("huge_t");
    expect(schema[0].type).toBe("HUGEINT");
    const qr = await engine.executeQueryWithLimit("SELECT h FROM huge_t");
    expect(qr.columns[0].type).toBe("HUGEINT");
  });

  // ==========================================================================
  // AB-1 ab_test（阶段三）
  // ==========================================================================

  it("AB-1 golden：z≈2.103、p≈0.0355、α=0.05 显著，效应量 +3pp/+30%", async () => {
    const r = await run({
      template: "ab_test",
      table: "ab_known",
      user_intent: "两版转化有差异吗",
      params: { variant_column: "variant", success_condition: "converted = true", unit: "user_id" },
    });
    const details = r.details as any;
    expect(details.error).toBeUndefined();
    expect(details.arms.map((a: any) => [a.variant, a.n, a.conv])).toEqual([
      ["control", 1000, 100],
      ["treatment", 1000, 130],
    ]);
    expect(Math.abs(details.z - 2.1032)).toBeLessThan(0.01);
    expect(Math.abs(details.p - 0.03545)).toBeLessThan(0.005);
    expect(details.significant).toBe(true);
    expect(details.absDiffPct).toBeCloseTo(3, 6);
    expect(details.liftPct).toBeCloseTo(30, 6);
    expect(details.betterArm).toBe("treatment");
    // p=0.0355 落在边缘区间 (0.01, 0.2) → 必须有谨慎提示（护栏 ③ 锁定）
    expect(details.warnings.some((w: string) => w.includes("边缘区间"))).toBe(true);
    expect((r.content[0] as any).text).toContain("方法与局限");
  });

  it("AB-1 小样本：不显著 + 两臂样本不足护栏", async () => {
    const r = await run({
      template: "ab_test",
      table: "ab_small",
      user_intent: "小样本检验",
      params: { variant_column: "variant", success_condition: "converted = true", unit: "user_id" },
    });
    const details = r.details as any;
    expect(Math.abs(details.p - 0.5383)).toBeLessThan(0.005);
    expect(details.significant).toBe(false);
    const sampleWarnings = details.warnings.filter((w: string) => w.includes("样本量 50 < 100"));
    expect(sampleWarnings).toHaveLength(2);
  });

  it("AB-1 辛普森构造：总体 treatment 优、两段内 control 优 → 悖论警告", async () => {
    const r = await run({
      template: "ab_test",
      table: "ab_simpson",
      user_intent: "分段看有没有辛普森悖论",
      params: {
        variant_column: "variant",
        success_condition: "converted = true",
        unit: "user_id",
        segment_columns: ["segment"],
      },
    });
    const details = r.details as any;
    expect(details.arms.map((a: any) => a.rate)).toEqual([0.038, 0.091]);
    expect(details.betterArm).toBe("treatment");
    expect(details.simpsonFindings).toHaveLength(2);
    expect(details.simpsonFindings[0]).toContain("segment = \"high\"");
    expect(details.warnings.some((w: string) => w.includes("辛普森悖论风险"))).toBe(true);
  });

  it("AB-1 第三变体 → invalid_params（variant_column）", async () => {
    const r = await run({
      template: "ab_test",
      table: "ab_three",
      user_intent: "三组能比吗",
      params: { variant_column: "variant", success_condition: "converted = true", unit: "user_id" },
    });
    const details = r.details as any;
    expect(details.error).toBe("invalid_params");
    expect(details.param).toBe("variant_column");
    expect((r.content[0] as any).text).toContain("恰好有 2 个非空取值");
  });

  it("AB-1 退化臂（全转化）→ 无法检验提示", async () => {
    const r = await run({
      template: "ab_test",
      table: "ab_edge",
      user_intent: "全转化怎么算",
      params: { variant_column: "variant", success_condition: "converted = true", unit: "user_id" },
    });
    const details = r.details as any;
    expect(details.error).toBeUndefined();
    expect(details.warnings.some((w: string) => w.includes("转化率 0% 或 100%"))).toBe(true);
  });

  it("AB-1 alpha 覆盖：α=0.01 时 p=0.0355 不显著", async () => {
    const r = await run({
      template: "ab_test",
      table: "ab_known",
      user_intent: "更严格显著性水平",
      params: { variant_column: "variant", success_condition: "converted = true", unit: "user_id", alpha: 0.01 },
    });
    expect((r.details as any).significant).toBe(false);
  });

  it("AB-1 分段列缺失 → missing_column 预校验", async () => {
    const r = await run({
      template: "ab_test",
      table: "ab_known",
      user_intent: "分段列写错了",
      params: { variant_column: "variant", success_condition: "converted = true", unit: "user_id", segment_columns: ["no_such_seg"] },
    });
    expect((r.details as any).error).toBe("missing_column");
    expect((r.details as any).missingColumns).toEqual(["no_such_seg"]);
  });

  it("AB 统计核心：normalCdf 单位性质（对称性、中点、常用分位）", async () => {
    const { normalCdf } = await import("../analysis/pm-templates.js");
    // Zelen–Severo 近似（|ε| < 7.5e-8），中点/分位用容差断言而非精确相等
    expect(Math.abs(normalCdf(0) - 0.5)).toBeLessThan(1e-9);
    expect(Math.abs(normalCdf(1.959963985) - 0.975)).toBeLessThan(1e-6);
    expect(Math.abs(normalCdf(-1.959963985) - 0.025)).toBeLessThan(1e-6);
    expect(Math.abs(normalCdf(1) + normalCdf(-1) - 1)).toBeLessThan(1e-12);
  });
});

// 纯函数补充：funnel SQL 生成不含意外标识符改写
describe("buildFunnelSql", () => {
  it("窗口子句与累计合取过滤器生成正确", () => {
    const sql = buildFunnelSql("orders", {
      steps: [
        { label: "a", condition: "amount >= 50" },
        { label: "b", condition: "has_coupon = true" },
      ],
      user_key: "user_id",
      time_column: "order_date",
      window_days: 30,
    });
    expect(sql).toContain(`"orders"`);
    expect(sql).toContain(`"user_id"`);
    expect(sql).toContain(`INTERVAL (30) DAY`);
    expect(sql).toContain(`COUNT(*) FILTER (WHERE s1) AS step_1`);
    expect(sql).toContain(`COUNT(*) FILTER (WHERE s1 AND s2) AS step_2`);
  });
});
