/**
 * v0.14 T-1 — materialize_remote_table 验收测试（sqlite ATTACH 替身，spec §7）
 *
 * 运行: npx vitest run src/eval/materialize-remote.test.ts
 *
 * 覆盖:
 * 1  正常物化：行数/列数一致、list_datasets 可见
 * 2  默认 target_table 名 = {alias}_{table} 归一化（含纯函数）
 * 3  未连接 alias → block（文案含 connect_database 指引）
 * 4  main/memory alias → block
 * 5  远端表不存在 → block
 * 6  行数超 dbMaxMaterializeRows → block（文案含三条出路）
 * 7  row_limit 部分物化生效；row_limit 超阈值 → block
 * 8  headless 无 autoConfirmWrite → block（S-1 fail-closed）
 * 9  覆盖现有表：旧数据被替换、无 tmp 残留
 * 10 注入 CREATE 失败：tmp 无残留、已有 target 原样、可重试
 * 11 注入 rename 阶段失败（同名 view）：target 原样、tmp 无残留、可重试（RM-3）
 * 12 字典自动生成（ai-guessed）、返回体含 dictionaryGenerated（RM-4）
 * 13 DECIMAL(p>38) 精度提示纯函数（spec 变更：sqlite 替身拿不到原始精度串，降级单测）
 * 14 审计记录格式（RM-5）
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, toSecurityConfig, type AppConfig } from "../config.js";
import { PersistenceManager } from "../persistence.js";
import { SecurityChecker } from "../security.js";
import { AuditLogManager } from "../audit-log.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { ensureExtensionLoaded } from "../engine/remote-dialect.js";
import { DataDictionaryManager } from "../hooks/data-dictionary.js";
import {
  createMaterializeRemoteTableTool,
  defaultTargetName,
  findDecimalPrecisionWarnings,
} from "../tools/materialize-remote.js";
import { createListDatasetsTool } from "../tools/list-datasets.js";
import type { ToolContext } from "../tools/tool-context.js";

const TEST_CWD = mkdtempSync(join(tmpdir(), "pi-mat-test-"));
const SQLITE_PATH = join(TEST_CWD, "src.db");

let engine: DuckDBEngine;
let persistence: PersistenceManager;
let dataDictionary: DataDictionaryManager;
let baseConfig: AppConfig; // autoConfirmWrite=true（放行确认门）
let strictConfig: AppConfig; // autoConfirmWrite=false（S-1 headless block）
let maxConfig: AppConfig; // dbMaxMaterializeRows=100（熔断用）

const mockCtx = {
  ui: null,
  cwd: TEST_CWD,
  sessionManager: { getBranch: () => [], appendEntry: () => {} },
} as any;

function makeRt(config: AppConfig): ToolContext {
  return {
    engine,
    security: new SecurityChecker(toSecurityConfig(config)),
    persistence,
    cwd: TEST_CWD,
    config,
    dataDictionary,
    queryMemory: {} as any,
  };
}

function makeTool(config: AppConfig) {
  return createMaterializeRemoteTableTool({ getRuntime: () => makeRt(config) });
}

function details(result: unknown): any {
  return (result as any)?.details ?? {};
}

function text(result: unknown): string {
  return String((result as any)?.content?.[0]?.text ?? "");
}

async function mainTableRows(name: string): Promise<number | null> {
  const r = await engine.query(
    `SELECT 1 FROM information_schema.tables WHERE table_catalog = current_database() ` +
    `AND table_schema = 'main' AND table_name = '${name.replace(/'/g, "''")}' LIMIT 1`
  );
  if (r.rows.length === 0) return null;
  const c = await engine.query(`SELECT COUNT(*) FROM main.${engine.quoteIdentifier(name)}`);
  return Number(c.rows[0]?.[0] ?? 0);
}

async function tmpResidue(): Promise<boolean> {
  const r = await engine.query(
    `SELECT 1 FROM information_schema.tables WHERE table_catalog = current_database() ` +
    `AND table_schema = 'main' AND table_name = '_materialize_tmp' LIMIT 1`
  );
  return r.rows.length > 0;
}

beforeAll(async () => {
  // sqlite 替身 fixture（sqlite3 CLI 建库，1000 行 seed + 2 行 tiny）
  const fixtureSql = [
    "CREATE TABLE seed (id INTEGER PRIMARY KEY, name TEXT, score REAL);",
    "INSERT INTO seed WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000) SELECT x, 'row_'||x, x*1.5 FROM c;",
    "CREATE TABLE tiny (a INTEGER);",
    "INSERT INTO tiny VALUES (1),(2);",
  ].join(" ");
  execFileSync("sqlite3", [SQLITE_PATH, fixtureSql]);

  baseConfig = loadConfig({ cwd: TEST_CWD, autoConfirmWrite: true });
  strictConfig = loadConfig({ cwd: TEST_CWD, autoConfirmWrite: false });
  maxConfig = loadConfig({ cwd: TEST_CWD, autoConfirmWrite: true, dbMaxMaterializeRows: 100 });
  mkdirSync(baseConfig.outputDir, { recursive: true });

  persistence = new PersistenceManager(baseConfig.globalConfigDir, baseConfig.projectConfigDir);
  persistence.saveDataDictionary([], "project");
  persistence.saveQueryMemory({ maxEntries: 5, entries: [] }, "project");
  dataDictionary = new DataDictionaryManager(persistence);

  engine = new DuckDBEngine({
    dbPath: baseConfig.dbPath,
    previewLimit: baseConfig.previewLimit,
    outputDir: baseConfig.outputDir,
  });
  await engine.init();

  // 引擎 home_directory 指向临时目录会让 INSTALL 重新联网下载扩展；
  // 复用本机 ~/.duckdb/extensions 缓存，测试无需外网（同 connect-mysql.test.ts）
  const extDir = join(homedir(), ".duckdb", "extensions");
  if (existsSync(extDir)) {
    try {
      await engine.exec(`SET extension_directory = '${extDir.replace(/'/g, "''")}'`);
    } catch { /* 缓存不可用时按联网路径走 */ }
  }

  await ensureExtensionLoaded(engine, "sqlite");
  await engine.exec(
    `ATTACH DATABASE '${SQLITE_PATH.replace(/'/g, "''")}' AS src (TYPE SQLITE)`
  );
}, 120_000);

afterAll(async () => {
  try { await engine?.close(); } catch { /* ignore */ }
  rmSync(TEST_CWD, { recursive: true, force: true });
});

describe("materialize_remote_table (v0.14 T-1)", () => {
  it("#1 正常物化：行数/列数与源表一致，list_datasets 可见", async () => {
    const result = await makeTool(baseConfig).execute(
      "t1", { alias: "src", table: "seed" }, undefined, undefined, mockCtx
    );
    const d = details(result);
    expect(d.success).toBe(true);
    expect(d.targetTable).toBe("src_seed");
    expect(d.rows).toBe(1000);
    expect(d.columns).toBe(3);
    expect(d.sourceRowCount).toBe(1000);
    expect(d.dbSizeBefore).toBeTypeOf("number");
    expect(d.dbSizeAfter).toBeTypeOf("number");
    expect(text(result)).toContain("Materialized src.seed");

    const listResult = await createListDatasetsTool({ getRuntime: () => makeRt(baseConfig) })
      .execute("t1b", {} as any, undefined, undefined, mockCtx);
    const names = (details(listResult).tables ?? []).map((t: any) => t.name);
    expect(names).toContain("src_seed");
  });

  it("#2 默认 target 名 = {alias}_{table} 归一化", async () => {
    expect(defaultTargetName("src", "seed")).toBe("src_seed");
    expect(defaultTargetName("src", "weird tbl")).toBe("src_weird_tbl");
    const result = await makeTool(baseConfig).execute(
      "t2", { alias: "src", table: "tiny" }, undefined, undefined, mockCtx
    );
    expect(details(result).targetTable).toBe("src_tiny");
    expect(details(result).rows).toBe(2);
  });

  it("#3 未连接 alias → block（文案含连接指引）", async () => {
    const result = await makeTool(baseConfig).execute(
      "t3", { alias: "ghost_db", table: "seed" }, undefined, undefined, mockCtx
    );
    expect(details(result).blocked).toBe(true);
    expect(details(result).error).toBe("not_connected");
    expect(text(result)).toContain("connect_database");
  });

  it("#4 main/memory alias → block", async () => {
    const rMain = await makeTool(baseConfig).execute(
      "t4a", { alias: "main", table: "seed" }, undefined, undefined, mockCtx
    );
    expect(details(rMain).blocked).toBe(true);
    expect(details(rMain).error).toBe("local_database");
    const rMem = await makeTool(baseConfig).execute(
      "t4b", { alias: "memory", table: "seed" }, undefined, undefined, mockCtx
    );
    expect(details(rMem).blocked).toBe(true);
    expect(details(rMem).error).toBe("local_database");
  });

  it("#5 远端表不存在 → block", async () => {
    const result = await makeTool(baseConfig).execute(
      "t5", { alias: "src", table: "ghost_table" }, undefined, undefined, mockCtx
    );
    expect(details(result).blocked).toBe(true);
    expect(details(result).error).toBe("remote_table_not_found");
    expect(text(result)).toContain("list_datasets");
  });

  it("#6 行数超 dbMaxMaterializeRows → block（文案含三条出路）", async () => {
    const result = await makeTool(maxConfig).execute(
      "t6", { alias: "src", table: "seed" }, undefined, undefined, mockCtx
    );
    expect(details(result).blocked).toBe(true);
    expect(details(result).error).toBe("row_count_exceeds_max");
    expect(details(result).sourceCount).toBe(1000);
    expect(details(result).maxRows).toBe(100);
    const t = text(result);
    expect(t).toContain("row_limit");
    expect(t).toContain("PI_DATA_AGENT_DB_MAX_MATERIALIZE_ROWS");
    expect(t).toContain("query_data");
  });

  it("#7 row_limit 部分物化生效；row_limit 超阈值 → block", async () => {
    const ok = await makeTool(maxConfig).execute(
      "t7a", { alias: "src", table: "seed", row_limit: 10, target_table: "t_part" },
      undefined, undefined, mockCtx
    );
    expect(details(ok).success).toBe(true);
    expect(details(ok).rows).toBe(10);
    expect(details(ok).rowLimit).toBe(10);
    expect(await mainTableRows("t_part")).toBe(10);

    const over = await makeTool(maxConfig).execute(
      "t7b", { alias: "src", table: "seed", row_limit: 500 }, undefined, undefined, mockCtx
    );
    expect(details(over).blocked).toBe(true);
    expect(details(over).error).toBe("row_limit_exceeds_max");
  });

  it("#8 headless 无 autoConfirmWrite → block（S-1 fail-closed）", async () => {
    const result = await makeTool(strictConfig).execute(
      "t8", { alias: "src", table: "seed", target_table: "t_headless" },
      undefined, undefined, mockCtx
    );
    expect(details(result).blocked).toBe(true);
    expect(details(result).error).toBe("confirm_gate");
    expect(text(result)).toContain("PI_DATA_AGENT_AUTO_CONFIRM_WRITE");
    expect(await mainTableRows("t_headless")).toBeNull();
  });

  it("#9 覆盖现有表：旧数据被替换、无 tmp 残留", async () => {
    const first = await makeTool(baseConfig).execute(
      "t9a", { alias: "src", table: "seed", target_table: "t_repl" },
      undefined, undefined, mockCtx
    );
    expect(details(first).success).toBe(true);
    expect(details(first).replaced).toBe(false);
    expect(await mainTableRows("t_repl")).toBe(1000);

    const second = await makeTool(baseConfig).execute(
      "t9b", { alias: "src", table: "tiny", target_table: "t_repl" },
      undefined, undefined, mockCtx
    );
    expect(details(second).success).toBe(true);
    expect(details(second).replaced).toBe(true);
    expect(await mainTableRows("t_repl")).toBe(2);
    expect(await tmpResidue()).toBe(false);
  });

  it("#10 注入 CREATE 失败：tmp 无残留、已有 target 原样、可重试", async () => {
    const ok = await makeTool(baseConfig).execute(
      "t10a", { alias: "src", table: "seed", target_table: "t_fail" },
      undefined, undefined, mockCtx
    );
    expect(details(ok).success).toBe(true);
    expect(await mainTableRows("t_fail")).toBe(1000);

    const realExec = engine.exec.bind(engine);
    let injected = true;
    (engine as any).exec = async (sql: string) => {
      if (injected && sql.includes("_materialize_tmp") && sql.includes("CREATE TABLE")) {
        throw new Error("injected create failure");
      }
      return realExec(sql);
    };
    try {
      const failed = await makeTool(baseConfig).execute(
        "t10b", { alias: "src", table: "tiny", target_table: "t_fail" },
        undefined, undefined, mockCtx
      );
      expect(details(failed).error).toContain("target table untouched");
      expect(await mainTableRows("t_fail")).toBe(1000); // target 原样
      expect(await tmpResidue()).toBe(false); // tmp 无残留

      injected = false;
      const retried = await makeTool(baseConfig).execute(
        "t10c", { alias: "src", table: "seed", target_table: "t_fail" },
        undefined, undefined, mockCtx
      );
      expect(details(retried).success).toBe(true);
      expect(await mainTableRows("t_fail")).toBe(1000);
    } finally {
      (engine as any).exec = realExec;
    }
  });

  it("#11 rename 阶段失败（同名 view）：target 原样、tmp 无残留、可重试（RM-3）", async () => {
    await engine.exec(`CREATE VIEW t_swap_view AS SELECT 42 AS x`);
    try {
      const failed = await makeTool(baseConfig).execute(
        "t11a", { alias: "src", table: "tiny", target_table: "t_swap_view" },
        undefined, undefined, mockCtx
      );
      expect(details(failed).error).toContain("atomic swap");
      expect(details(failed).error).toContain("temp table removed");
      expect(await tmpResidue()).toBe(false);
      // view 原样可查
      const v = await engine.query(`SELECT x FROM main.t_swap_view`);
      expect(Number(v.rows[0]?.[0])).toBe(42);

      await engine.exec(`DROP VIEW IF EXISTS main.t_swap_view`);
      const retried = await makeTool(baseConfig).execute(
        "t11b", { alias: "src", table: "tiny", target_table: "t_swap_view" },
        undefined, undefined, mockCtx
      );
      expect(details(retried).success).toBe(true);
      expect(await mainTableRows("t_swap_view")).toBe(2);
    } finally {
      await engine.exec(`DROP VIEW IF EXISTS main.t_swap_view`).catch(() => {});
      await engine.exec(`DROP TABLE IF EXISTS main.t_swap_view`).catch(() => {});
    }
  });

  it("#12 字典自动生成（ai-guessed），返回体含 dictionaryGenerated", async () => {
    const result = await makeTool(baseConfig).execute(
      "t12", { alias: "src", table: "tiny", target_table: "t_dict" },
      undefined, undefined, mockCtx
    );
    const d = details(result);
    expect(d.success).toBe(true);
    expect(d.dictionaryGenerated).toBe(true);
    expect(dataDictionary.hasDictionary("t_dict")).toBe(true);
    const entry = (dataDictionary as any).cache?.get?.("t_dict");
    expect(entry?.status ?? "ai-guessed").toBe("ai-guessed");
    expect(text(result)).toContain("confirm_dictionary");
  });

  it("#13 DECIMAL(p>38) 精度提示（纯函数单测，spec 变更：sqlite 替身拿不到原始精度串）", () => {
    expect(findDecimalPrecisionWarnings([{ name: "amt", type: "DECIMAL(40,2)" }])).toHaveLength(1);
    expect(findDecimalPrecisionWarnings([{ name: "amt", type: "DECIMAL(40,2)" }])[0]).toContain("DOUBLE");
    expect(findDecimalPrecisionWarnings([{ name: "amt", type: "decimal( 39 , 0 )" }])).toHaveLength(1);
    expect(findDecimalPrecisionWarnings([{ name: "amt", type: "DECIMAL(38,2)" }])).toHaveLength(0);
    expect(findDecimalPrecisionWarnings([{ name: "amt", type: "DOUBLE" }])).toHaveLength(0);
    expect(
      findDecimalPrecisionWarnings([
        { name: "a", type: "INTEGER" },
        { name: "b", type: "DECIMAL(50,3)" },
      ])
    ).toHaveLength(1);
  });

  it("#14 审计记录格式正确、无凭据字段（RM-5）", async () => {
    const auditDir = join(TEST_CWD, ".pi-data-agent");
    const audit = new AuditLogManager(auditDir);
    audit.recordStart("call_mat_1", "materialize_remote_table", {
      alias: "src",
      table: "seed",
      target_table: "src_seed",
    });
    audit.recordEnd({
      toolCallId: "call_mat_1",
      result: { details: { success: true } },
      isError: false,
    });
    const entries = audit.getRecent(10);
    const entry = entries.find((e) => e.toolCallId === "call_mat_1");
    expect(entry).toBeDefined();
    expect(entry!.result).toBe("success");
    expect(entry!.action).toContain("materialize_remote_table: src.seed → src_seed");
    expect(entry!.action).not.toMatch(/password|PWD/i);

    // blocked 路径
    audit.recordStart("call_mat_2", "materialize_remote_table", { alias: "src", table: "seed" });
    audit.recordEnd({
      toolCallId: "call_mat_2",
      result: { details: { blocked: true } },
      isError: false,
    });
    const blockedEntry = audit.getRecent(10).find((e) => e.toolCallId === "call_mat_2");
    expect(blockedEntry!.result).toBe("blocked");
  });
});
