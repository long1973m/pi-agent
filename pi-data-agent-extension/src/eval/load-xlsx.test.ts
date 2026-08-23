/**
 * v0.9 A-1 — load_data Excel 支持验收测试（vitest）
 *
 * 覆盖:
 * - X1: 默认加载第一个 sheet，details 列出全部 sheet 名
 * - X2: 指定 sheet_name 加载对应 sheet
 * - X3: 中文表头、数值、日期类型推断正确
 * - X4: 非 Excel 内容伪装 .xlsx 时报错清晰，不崩溃
 * - X5: 临时 CSV 用完即删（不残留 pi-data-agent_xlsx_*.csv）
 * - X6: 扩展名伪装成 .csv 的 xlsx 通过 magic bytes 兜底识别
 * - X7: 现有 CSV 加载行为不变（回归）
 *
 * 测试约束：独立临时目录（不写共享 session.duckdb），不依赖网络与真实 LLM。
 */

import { describe, it, expect, afterEach } from "vitest";
import * as XLSX from "xlsx";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig, toSecurityConfig } from "../config.js";
import { SecurityChecker } from "../security.js";
import { DuckDBEngine } from "../engine/duckdb.js";
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
    // 本文件测加载逻辑而非确认门；headless 下写 SQL 需显式放行（v0.11 S-1 fail-closed）
    autoConfirmWrite: true,
    dbPath: join(dir, ".pi-data-agent", "session.duckdb"),
    projectConfigDir: join(dir, ".pi-data-agent"),
    outputDir: join(dir, ".pi-data-agent", "output"),
    uploadsDir: join(dir, ".pi-data-agent", "uploads"),
  });
}

async function setup(): Promise<{ tool: ReturnType<typeof createLoadDataTool>; dir: string }> {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-load-xlsx-test-"));
  const config = makeIsolatedConfig(tmpDir);
  engine = new DuckDBEngine({
    dbPath: config.dbPath,
    previewLimit: config.previewLimit,
    outputDir: config.outputDir,
  });
  await engine.init();
  const security = new SecurityChecker(toSecurityConfig(config));
  const context: ToolContext = {
    engine,
    security,
    persistence: {} as never,
    cwd: config.cwd,
    config,
    // 字典桩：记录调用即可，不影响加载主流程
    dataDictionary: {
      hasDictionary: () => false,
      ensureDictionary: async () => ({}) as never,
      refreshFingerprint: async () => undefined,
    } as never,
    queryMemory: {} as never,
  };
  const tool = createLoadDataTool({ getRuntime: () => context });
  return { tool, dir: tmpDir };
}

/** 构造多 sheet xlsx：sheet1 中文表头订单数据，sheet2 城市人口 */
function buildMultiSheetXlsx(filePath: string): void {
  const wb = XLSX.utils.book_new();
  const wsOrders = XLSX.utils.aoa_to_sheet([
    ["订单ID", "渠道", "金额", "下单时间"],
    ["A001", "app", 10.5, "2024-06-01 08:30:00"],
    ["A002", "web", 22.0, "2024-06-02 09:00:00"],
    ["A003", "app", 35.75, "2024-06-03 10:15:00"],
  ]);
  XLSX.utils.book_append_sheet(wb, wsOrders, "订单明细");
  const wsCities = XLSX.utils.aoa_to_sheet([
    ["城市", "人口"],
    ["北京", 2189],
    ["上海", 2487],
  ]);
  XLSX.utils.book_append_sheet(wb, wsCities, "城市概览");
  XLSX.writeFile(wb, filePath);
}

/** 统计系统临时目录下残留的 Excel 转换 CSV */
function leftoverTempCsvCount(): number {
  return readdirSync(tmpdir()).filter((n) => n.startsWith("pi-data-agent_xlsx_")).length;
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

describe("load_data Excel 支持（A-1）", () => {
  it("X1: 默认加载第一个 sheet，details 附全部 sheet 名", async () => {
    const { tool, dir } = await setup();
    const filePath = join(dir, "sales.xlsx");
    buildMultiSheetXlsx(filePath);

    const result = await tool.execute("x1", { file_path: filePath }, undefined, undefined, { ui: null, cwd: dir } as never);
    const details = result.details as Record<string, unknown>;
    const text = String((result.content as Array<{ text: string }>)[0]?.text ?? "");

    expect(details.error).toBeUndefined();
    expect(details.tableName).toBe("sales");
    expect(details.format).toBe("excel");
    expect(details.availableSheets).toEqual(["订单明细", "城市概览"]);
    expect(details.selectedSheet).toBe("订单明细");
    expect(details.rowCount).toBe(3);
    expect(text).toContain("Loaded \"sales\"");
    expect(text).toContain("订单ID");

    // 表确实可查询
    const q = await engine!.query('SELECT COUNT(*) FROM "sales"');
    expect(Number(q.rows[0][0])).toBe(3);
  });

  it("X2: 指定 sheet_name 可加载对应 sheet", async () => {
    const { tool, dir } = await setup();
    const filePath = join(dir, "sales.xlsx");
    buildMultiSheetXlsx(filePath);

    const result = await tool.execute(
      "x2",
      { file_path: filePath, sheet_name: "城市概览", table_name: "cities" },
      undefined,
      undefined,
      { ui: null, cwd: dir } as never
    );
    const details = result.details as Record<string, unknown>;

    expect(details.error).toBeUndefined();
    expect(details.tableName).toBe("cities");
    expect(details.selectedSheet).toBe("城市概览");
    expect(details.rowCount).toBe(2);

    const schema = await engine!.getSchema("cities");
    expect(schema.map((c) => c.name)).toEqual(["城市", "人口"]);
  });

  it("X3: 中文表头保留，数值/时间类型推断正确", async () => {
    const { tool, dir } = await setup();
    const filePath = join(dir, "typed.xlsx");
    buildMultiSheetXlsx(filePath);

    const result = await tool.execute("x3", { file_path: filePath }, undefined, undefined, { ui: null, cwd: dir } as never);
    expect((result.details as Record<string, unknown>).error).toBeUndefined();

    const schema = await engine!.getSchema("typed");
    const byName = new Map(schema.map((c) => [c.name, c.type]));
    expect(byName.get("订单ID")).toBeDefined();
    expect(byName.get("金额")).toMatch(/DOUBLE|DECIMAL/);
    expect(byName.get("下单时间")).toMatch(/TIMESTAMP|DATE/);
  });

  it("X4: 非 Excel 内容伪装 .xlsx 报错清晰，不崩溃", async () => {
    const { tool, dir } = await setup();
    const filePath = join(dir, "fake.xlsx");
    writeFileSync(filePath, "this is definitely not an excel file");

    const result = await tool.execute("x4", { file_path: filePath }, undefined, undefined, { ui: null, cwd: dir } as never);
    const text = String((result.content as Array<{ text: string }>)[0]?.text ?? "");
    const details = result.details as Record<string, unknown>;

    expect(text).toContain("Load failed");
    expect(text).toContain("Excel");
    expect(details.error).toBeDefined();
  });

  it("X5: 临时 CSV 用完即删", async () => {
    const { tool, dir } = await setup();
    const filePath = join(dir, "cleanup.xlsx");
    buildMultiSheetXlsx(filePath);
    expect(leftoverTempCsvCount()).toBe(0);

    await tool.execute("x5", { file_path: filePath }, undefined, undefined, { ui: null, cwd: dir } as never);
    expect(leftoverTempCsvCount()).toBe(0);

    // 失败路径也不残留
    const badPath = join(dir, "bad.xlsx");
    writeFileSync(badPath, "not excel");
    await tool.execute("x5b", { file_path: badPath }, undefined, undefined, { ui: null, cwd: dir } as never);
    expect(leftoverTempCsvCount()).toBe(0);
  });

  it("X6: 扩展名为 .csv 但内容是 xlsx 时 magic bytes 兜底识别", async () => {
    const { tool, dir } = await setup();
    const xlsxPath = join(dir, "real.xlsx");
    buildMultiSheetXlsx(xlsxPath);
    const disguisedPath = join(dir, "disguised.csv");
    copyFileSync(xlsxPath, disguisedPath);

    const result = await tool.execute("x6", { file_path: disguisedPath }, undefined, undefined, { ui: null, cwd: dir } as never);
    const details = result.details as Record<string, unknown>;

    expect(details.error).toBeUndefined();
    expect(details.format).toBe("excel");
    expect(details.availableSheets).toEqual(["订单明细", "城市概览"]);
  });

  it("X7: 回归——CSV 加载行为不变", async () => {
    const { tool, dir } = await setup();
    const filePath = join(dir, "plain.csv");
    writeFileSync(filePath, "id,score\n1,90\n2,80\n3,70\n");

    const result = await tool.execute("x7", { file_path: filePath }, undefined, undefined, { ui: null, cwd: dir } as never);
    const details = result.details as Record<string, unknown>;

    expect(details.error).toBeUndefined();
    expect(details.format).toBe("csv");
    expect(details.rowCount).toBe(3);
    expect(details.availableSheets).toBeUndefined();

    const schema = await engine!.getSchema("plain");
    expect(schema.map((c) => c.name)).toEqual(["id", "score"]);
  });
});
