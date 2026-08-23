/**
 * v0.9 A-5 — 数据体检卡验收测试（vitest）
 *
 * 覆盖:
 * - P1: 缺失率阈值（>30% 需关注、>80% 严重）
 * - P2: 疑似主键重复（COUNT − COUNT(DISTINCT) > 0）
 * - P3: 恒定列（approx_unique = 1）与低基数列（∈[2,20]）
 * - P4: 时间列跨度
 * - P5: 建议问题生成（≤3 条：趋势 / Top N / 排名）
 * - P6: 大表降级（估算行数 >100 万只做 SUMMARIZE，跳过逐列补充查询）
 * - P7: profile 失败不影响加载结果（load_data 集成 + dataProfile 结构化输出）
 * - D1/D2: 带精度类型（DECIMAL(9,2)）：schema 映射不降级 VARCHAR、体检卡数值列识别
 *
 * 测试约束：独立临时目录（不写共享 session.duckdb），不依赖网络与真实 LLM。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig, toSecurityConfig } from "../config.js";
import { SecurityChecker } from "../security.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { profileTable, formatProfileCard } from "../hooks/data-profile.js";
import { createLoadDataTool } from "../tools/load-data.js";
import type { ToolContext } from "../tools/tool-context.js";

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
    // P7b 走 load_data 工具链路，测体检卡而非确认门；headless 需显式放行（v0.11 S-1）
    autoConfirmWrite: true,
    dbPath: join(dir, ".pi-data-agent", "session.duckdb"),
    projectConfigDir: join(dir, ".pi-data-agent"),
    outputDir: join(dir, ".pi-data-agent", "output"),
    uploadsDir: join(dir, ".pi-data-agent", "uploads"),
  });
}

async function setup(): Promise<string> {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-profile-test-"));
  const config = makeIsolatedConfig(tmpDir);
  engine = new DuckDBEngine({
    dbPath: config.dbPath,
    previewLimit: config.previewLimit,
    outputDir: config.outputDir,
  });
  await engine.init();
  return tmpDir;
}

/** 构造体检样例表：
 *  - order_id 有 1 个重复（O1 出现两次）→ 主键嫌疑
 *  - category 低基数（app/web ∈ [2,20]）
 *  - amount 缺失 50%（>30% 需关注，≤80%）
 *  - note 恒定列（全 X）
 *  - sparse 缺失 90%（>80% 严重）
 *  - order_time 时间跨度 2024-06-01 ~ 2024-06-10
 */
const SAMPLE_CSV = [
  "order_id,category,amount,note,sparse,order_time",
  "O1,app,10.5,X,,2024-06-01 00:00:00",
  "O2,web,20.0,X,,2024-06-02 00:00:00",
  "O3,app,,X,,2024-06-03 00:00:00",
  "O4,web,15.5,X,,2024-06-04 00:00:00",
  "O1,app,,X,,2024-06-05 00:00:00",
  "O5,app,12.0,X,,2024-06-06 00:00:00",
  "O6,web,,X,,2024-06-07 00:00:00",
  "O7,app,18.2,X,,2024-06-08 00:00:00",
  "O8,web,,X,,2024-06-09 00:00:00",
  "O9,app,,,s1,2024-06-10 00:00:00",
].join("\n");

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

describe("数据体检卡 profileTable（A-5）", () => {
  it("P1-P4: 缺失率阈值/主键重复/恒定列/时间跨度", async () => {
    await setup();
    const csvPath = join(tmpDir!, "orders.csv");
    writeFileSync(csvPath, SAMPLE_CSV);
    await engine!.exec(`CREATE TABLE orders AS SELECT * FROM read_csv_auto('${csvPath}')`);

    const profile = await profileTable(engine!, "orders");

    // 基础信息
    expect(profile.rowCount).toBe(10);
    expect(profile.columnCount).toBe(6);

    // P1: 缺失率——amount 50% 需关注；sparse 90% 严重
    expect(profile.missingColumns.map((c) => c.name)).toContain("amount");
    expect(profile.missingColumns.find((c) => c.name === "amount")?.nullPercentage).toBeCloseTo(50, 0);
    expect(profile.severeMissingColumns.map((c) => c.name)).toContain("sparse");
    // amount 未达 80% 不应出现在严重列表
    expect(profile.severeMissingColumns.map((c) => c.name)).not.toContain("amount");

    // P2: 疑似主键重复——order_id 重复 1 个
    const pk = profile.primaryKeySuspicion.find((p) => p.column === "order_id");
    expect(pk).toBeDefined();
    expect(pk!.duplicateCount).toBe(1);

    // P3: 恒定列 note；低基数列 category
    expect(profile.constantColumns).toContain("note");
    const cat = profile.lowCardinalityColumns.find((c) => c.name === "category");
    expect(cat).toBeDefined();
    expect(cat!.approxUnique).toBe(2);

    // P4: 时间跨度
    expect(profile.timeSpan).toBeDefined();
    expect(profile.timeSpan!.column).toBe("order_time");
    expect(profile.timeSpan!.min).toContain("2024-06-01");
    expect(profile.timeSpan!.max).toContain("2024-06-10");

    expect(profile.degraded).toBe(false);
  });

  it("P5: 建议问题 ≤3 条且覆盖趋势/TopN/排名", async () => {
    await setup();
    const csvPath = join(tmpDir!, "orders.csv");
    writeFileSync(csvPath, SAMPLE_CSV);
    await engine!.exec(`CREATE TABLE orders AS SELECT * FROM read_csv_auto('${csvPath}')`);

    const profile = await profileTable(engine!, "orders");

    expect(profile.suggestedQuestions.length).toBeGreaterThanOrEqual(1);
    expect(profile.suggestedQuestions.length).toBeLessThanOrEqual(3);
    const joined = profile.suggestedQuestions.join("\n");
    // 趋势问句（有时间列）
    expect(joined).toContain("order_time");
    // Top N 问句（低基数维度 × 数值列）
    expect(joined).toContain("category");
    // 排名问句（金额类数值列）
    expect(joined).toContain("amount");
  });

  it("P6: 大表降级——估算行数 >100 万只做 SUMMARIZE", async () => {
    await setup();
    const csvPath = join(tmpDir!, "orders.csv");
    writeFileSync(csvPath, SAMPLE_CSV);
    await engine!.exec(`CREATE TABLE big_orders AS SELECT * FROM read_csv_auto('${csvPath}')`);

    const profile = await profileTable(engine!, "big_orders", { estimatedRowCount: 2_000_000 });

    expect(profile.degraded).toBe(true);
    expect(profile.rowCount).toBe(2_000_000);
    // SUMMARIZE 结果仍然可用
    expect(profile.columnCount).toBe(6);
    expect(profile.severeMissingColumns.map((c) => c.name)).toContain("sparse");
    // 逐列补充查询被跳过 → 无主键重复检测结果
    expect(profile.primaryKeySuspicion).toEqual([]);
  });

  it("P7a: 表不存在时 profileTable 抛错（由调用方静默容错）", async () => {
    await setup();
    await expect(profileTable(engine!, "no_such_table")).rejects.toThrow();
  });

  it("P7b: load_data 集成——content 附体检卡、details 附 dataProfile、字典行为不变", async () => {
    await setup();
    const csvPath = join(tmpDir!, "ecommerce.csv");
    writeFileSync(csvPath, SAMPLE_CSV);

    const config = makeIsolatedConfig(tmpDir!);
    const security = new SecurityChecker(toSecurityConfig(config));
    const dictCalls: string[] = [];
    const context: ToolContext = {
      engine,
      security,
      persistence: {} as never,
      cwd: config.cwd,
      config,
      dataDictionary: {
        hasDictionary: () => false,
        ensureDictionary: async (t: string) => {
          dictCalls.push(t);
          return {} as never;
        },
        refreshFingerprint: async () => undefined,
      } as never,
      queryMemory: {} as never,
    };
    const tool = createLoadDataTool({ getRuntime: () => context });

    const result = await tool.execute(
      "p7b",
      { file_path: csvPath },
      undefined,
      undefined,
      { ui: null, cwd: tmpDir! } as never
    );
    const text = String((result.content as Array<{ text: string }>)[0]?.text ?? "");
    const details = result.details as Record<string, unknown>;

    // 加载成功不受体检影响
    expect(details.error).toBeUndefined();
    expect(text).toContain('Loaded "ecommerce"');

    // 字典静默生成行为不变
    expect(details.dictionaryGenerated).toBe(true);
    expect(dictCalls).toEqual(["ecommerce"]);

    // content 追加紧凑体检卡（≤8 行，卡片是最后一段）
    const chunks = text.split("\n\n");
    const cardLines = chunks[chunks.length - 1].split("\n");
    expect(text).toContain("数据体检");
    expect(cardLines.length).toBeLessThanOrEqual(8);
    expect(text).toContain("缺失率");
    expect(text).toContain("疑似主键重复");
    expect(text).toContain("时间跨度");
    expect(text).toContain("可以问我");

    // details 附结构化 dataProfile
    const dataProfile = details.dataProfile as Record<string, unknown>;
    expect(dataProfile).toBeDefined();
    expect(dataProfile.tableName).toBe("ecommerce");
    expect(dataProfile.rowCount).toBe(10);
    expect(Array.isArray(dataProfile.suggestedQuestions)).toBe(true);
  });

  it("P8: formatProfileCard 输出紧凑人话文本", async () => {
    await setup();
    const csvPath = join(tmpDir!, "orders.csv");
    writeFileSync(csvPath, SAMPLE_CSV);
    await engine!.exec(`CREATE TABLE card_t AS SELECT * FROM read_csv_auto('${csvPath}')`);
    const profile = await profileTable(engine!, "card_t");

    const card = formatProfileCard(profile);
    const lines = card.split("\n");

    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines[0]).toContain("card_t");
    expect(lines[0]).toContain("10 行 × 6 列");
    expect(card).not.toContain("undefined");
    expect(card).not.toContain("NaN");
  });
});

describe("带精度类型（DECIMAL(9,2)）识别", () => {
  it("D1: 引擎 schema 映射——DECIMAL(9,2)/VARCHAR(10) 不降级 VARCHAR，无 Unknown 警告", async () => {
    await setup();
    await engine!.exec(
      `CREATE TABLE precision_t (
        order_id VARCHAR,
        note VARCHAR(10),
        amount DECIMAL(9,2)
      )`
    );
    await engine!.exec(
      `INSERT INTO precision_t VALUES ('O1', 'a', 10.50), ('O2', 'b', 22.00), ('O3', 'a', 15.75)`
    );

    const warnSpy = vi.spyOn(console, "warn");
    try {
      // PRAGMA table_info 路径（getSchema）
      const schema = await engine!.getSchema("precision_t");
      const byName = new Map(schema.map((c) => [c.name, c.type]));
      expect(byName.get("amount")).toBe("DECIMAL");
      expect(byName.get("note")).toBe("VARCHAR");
      expect(byName.get("order_id")).toBe("VARCHAR");

      // 查询结果列路径（extractColumns）
      const q = await engine!.query("SELECT amount FROM precision_t LIMIT 1");
      expect(q.columns[0].type).toBe("DECIMAL");

      // 不再打 Unknown 类型警告
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Unknown DuckDB type"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("D2: 体检卡——DECIMAL(9,2) 列被认作数值列，金额类建议问题正常生成", async () => {
    await setup();
    await engine!.exec(
      `CREATE TABLE decimal_orders (
        order_id VARCHAR,
        category VARCHAR,
        amount DECIMAL(9,2)
      )`
    );
    await engine!.exec(
      `INSERT INTO decimal_orders VALUES
        ('O1', 'app', 10.50),
        ('O2', 'web', 22.00),
        ('O3', 'app', 15.75),
        ('O4', 'web', 8.20),
        ('O5', 'app', 30.10)`
    );

    const profile = await profileTable(engine!, "decimal_orders");

    // 数值列被识别 → 金额类排名问句生成（修复前 DECIMAL(9,2) 被当成非数值列而静默失效）
    const joined = profile.suggestedQuestions.join("\n");
    expect(joined).toContain("amount");
    expect(joined).toContain("最高 / 最低");
  });
});
