/**
 * v0.14 RM-2 — materialize_remote_table：远程表物化到本地
 *
 * 执行流（spec §3.2 六步）：
 * 1. 校验：alias 已 ATTACH（duckdb_databases()）且非 main/memory；alias.table 存在
 * 2. 规模探测：SELECT COUNT(*) FROM alias.table（v0.12 已确认 pushdown 下推远端）
 * 3. 熔断：count > dbMaxMaterializeRows 且无 row_limit → block（非 confirm）
 * 4. 确认门：resolveConfirmGate（S-1 fail-closed，文案含行数/目标表/是否替换）
 * 5. tmp → rename 原子替换：CREATE tmp → BEGIN; DROP target; RENAME; COMMIT；
 *    失败补 ROLLBACK + DROP tmp，绝不触碰已有 target（RM-3）
 * 6. 返回摘要：行数/列数/耗时/endpoint（无凭据）/duckdb 体积变化（RM-3）/
 *    DECIMAL(p>38) 精度提示（调研 §4.4）/ 字典生成标志（RM-4）
 *
 * 安全：
 * - 所有 error 路径过 redactCredentials（RM-5）
 * - 本地写操作经确认门，headless 无 autoConfirmWrite 即 block
 * - alias/target 走严格标识符校验，源表名经 quoteIdentifier 引用
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { ToolRegisterParams } from "./tool-context.js";
import { resolveConfirmGate, redactCredentials } from "../security.js";
import { getActiveRemoteConnections } from "../engine/remote-dialect.js";
import { MaterializationStore } from "../materialization-store.js";

/** materialize_remote_table 参数（无敏感字段——凭据在连接层） */
const MaterializeRemoteParams = Type.Object({
  alias: Type.String({
    description: "已 ATTACH 的数据库别名（connect_database 返回的 alias；非 main/memory）。",
  }),
  table: Type.String({
    description: "远程表名（alias 下的表，如 users）。",
  }),
  target_table: Type.Optional(Type.String({
    description: "本地目标表名，省略时默认 {alias}_{table} 归一化。与本地现有表重名时将替换之（确认门会声明）。",
  })),
  row_limit: Type.Optional(Type.Integer({
    description: "只物化前 N 行（部分物化）。不能超过行数熔断阈值。",
  })),
});

/** 严格标识符校验（alias / target；防注入，同时保证默认名可用） */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 本地 tmp 表名（固定） */
const TMP_TABLE = "_materialize_tmp";

/** 归一化默认目标表名：{alias}_{table}，非标识符字符 → _，数字开头前缀 _ */
export function defaultTargetName(alias: string, table: string): string {
  const raw = `${alias}_${table}`.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!raw) return "materialized_table";
  return /^[A-Za-z_]/.test(raw) ? raw : `_${raw}`;
}

/**
 * 源表列类型中的 DECIMAL(p>38) 精度坑检测（调研 §4.4：落地为 DOUBLE）
 *
 * 注意：多数 dialect 在 ATTACH 层就会把 p>38 转成 DOUBLE（sqlite 替身拿不到
 * 原始精度串），此函数为纯函数、尽力而为检测——T-1 #12 以合成类型串单测。
 */
export function findDecimalPrecisionWarnings(
  columns: Array<{ name: string; type: string }>
): string[] {
  const warnings: string[] = [];
  for (const c of columns) {
    const m = /DECIMAL\s*\(\s*(\d+)\s*,\s*\d+\s*\)/i.exec(c.type);
    if (m && Number(m[1]) > 38) {
      warnings.push(
        `列 ${c.name} (${c.type}) 精度超过 DuckDB DECIMAL 上限(38)，已落地为 DOUBLE，可能丢失精度`
      );
    }
  }
  return warnings;
}

type ToolContextEngine = NonNullable<ReturnType<NonNullable<ToolRegisterParams["getRuntime"]>>>["engine"];

/** 表存在于 alias 下（复用 connect_database 的三级 fallback 模式） */
async function remoteTableExists(
  engine: NonNullable<ToolContextEngine>,
  alias: string,
  table: string
): Promise<boolean> {
  const esc = (s: string) => s.replace(/'/g, "''");
  const probes = [
    `SELECT 1 FROM information_schema.tables WHERE table_schema = '${esc(alias)}' AND table_name = '${esc(table)}' LIMIT 1`,
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'main' AND table_catalog = '${esc(alias)}' AND table_name = '${esc(table)}' LIMIT 1`,
    `SELECT 1 FROM ${engine.quoteIdentifier(alias)}.${engine.quoteIdentifier(table)} LIMIT 0`,
  ];
  for (const sql of probes) {
    try {
      const r = await engine.query(sql);
      // information_schema 探针：查到行才算存在；直查探针（LIMIT 0）：不抛错即存在
      if (r.rows.length > 0) return true;
      if (sql.includes("LIMIT 0")) return true;
    } catch {
      // 下一级 fallback
    }
  }
  return false;
}

/**
 * 远端 information_schema 下推取列类型（真机 MySQL 验收发现）
 *
 * DuckDB 侧 getSchema 看到的已是转换后的类型：DECIMAL(p>38) 落地 DOUBLE，
 * 原始精度只在远端 column_type 里（如 "decimal(50,2)"）。精度提示必须下推取，
 * 否则提示永远为空。拿不到时返回 null，由调用方回退 DuckDB schema。
 */
async function fetchRemoteColumnTypes(
  engine: NonNullable<ToolContextEngine>,
  alias: string,
  table: string
): Promise<Array<{ name: string; type: string }> | null> {
  try {
    const r = await engine.query(
      `SELECT column_name, column_type FROM ${engine.quoteIdentifier(alias)}.information_schema.columns ` +
        `WHERE table_name = '${table.replace(/'/g, "''")}' AND column_type IS NOT NULL ` +
        `ORDER BY ordinal_position`
    );
    if (r.rows.length === 0) return null;
    return r.rows.map((row) => ({ name: String(row[0]), type: String(row[1]) }));
  } catch {
    // sqlite 等方言无 column_type 列 → 回退 DuckDB schema
    return null;
  }
}

/** 本地 main schema 是否已有同名表（table_catalog = 当前库，排除 attached 误判） */
async function localTableExists(
  engine: NonNullable<ToolContextEngine>,
  table: string
): Promise<boolean> {
  try {
    const r = await engine.query(
      `SELECT 1 FROM information_schema.tables WHERE table_catalog = current_database() ` +
      `AND table_schema = 'main' AND table_name = '${table.replace(/'/g, "''")}' LIMIT 1`
    );
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

export function createMaterializeRemoteTableTool(params: ToolRegisterParams): ToolDefinition {
  const blocked = (reason: string, details: Record<string, unknown> = {}): AgentToolResult<unknown> => ({
    content: [{ type: "text", text: `Security blocked: ${reason}` }],
    details: { toolName: "materialize_remote_table", blocked: true, reason, ...details },
  });
  const errorResult = (msg: string, details: Record<string, unknown> = {}): AgentToolResult<unknown> => {
    const safe = redactCredentials(msg);
    return {
      content: [{ type: "text", text: safe }],
      details: { toolName: "materialize_remote_table", error: safe, ...details },
    };
  };

  return {
    name: "materialize_remote_table",
    label: "Materialize Remote Table",
    description:
      "Materialize (copy) a table from an attached remote database into a local DuckDB table. " +
      "READ-ONLY copy: the remote database is never modified. " +
      "Guardrails: row count is probed first (COUNT pushdown); if it exceeds the hard limit " +
      "(PI_DATA_AGENT_DB_MAX_MATERIALIZE_ROWS, default 500000) the call is blocked — remedies: " +
      "(1) pass row_limit below the limit, (2) raise PI_DATA_AGENT_DB_MAX_MATERIALIZE_ROWS, " +
      "(3) filter on the remote side first via query_data and materialize the subset. " +
      "Local write goes through a confirmation gate (headless without " +
      "PI_DATA_AGENT_AUTO_CONFIRM_WRITE is rejected). Uses tmp→rename atomic swap: " +
      "on failure the existing target table is untouched. " +
      "Note: DECIMAL columns with precision > 38 land as DOUBLE (precision loss possible). " +
      "After success the data dictionary is auto-generated (use confirm_dictionary to correct it).",
    parameters: MaterializeRemoteParams,
    execute: async (
      toolCallId: string,
      args: { alias: string; table: string; target_table?: string; row_limit?: number },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      const rt = params.getRuntime();
      if (!rt?.engine) {
        return errorResult("DuckDB engine not available.", { error: "engine not available" });
      }
      const engine = rt.engine;
      const startTime = Date.now();

      // ---- 1. 校验：alias / table 标识符合法性 ----
      const alias = (args.alias ?? "").trim();
      const table = (args.table ?? "").trim();
      if (!IDENT_RE.test(alias)) {
        return blocked(`Invalid alias "${args.alias}". Must match [A-Za-z_][A-Za-z0-9_]*.`, { error: "invalid_alias" });
      }
      if (!table || !table.trim() || /[\u0000-\u001F]/.test(table)) {
        return blocked(`Invalid table name "${args.table}".`, { error: "invalid_table" });
      }
      if (alias === "main" || alias === "memory") {
        return blocked(
          `"${alias}" is a local database, not a remote attachment. ` +
          `Connect first with connect_database, then materialize from its alias.`,
          { error: "local_database", alias }
        );
      }

      // ---- 1b. alias 已 ATTACH（duckdb_databases()）----
      let dbInfo: { type: string; path: string } | null = null;
      try {
        const r = await engine.query(
          `SELECT type, path, internal FROM duckdb_databases() WHERE database_name = '${alias.replace(/'/g, "''")}'`
        );
        if (r.rows.length > 0 && !Boolean(r.rows[0][2])) {
          dbInfo = { type: String(r.rows[0][0] ?? ""), path: String(r.rows[0][1] ?? "") };
        }
      } catch (err) {
        return errorResult(`Failed to inspect attached databases: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!dbInfo) {
        return blocked(
          `Alias "${alias}" is not attached. Use connect_database first ` +
          `(e.g. { db_type: "sqlite", file_path: "..." } or { db_type: "mysql", host, user, database }), ` +
          `then retry with the returned alias.`,
          { error: "not_connected", alias }
        );
      }

      // ---- 1c. 远端表存在 ----
      if (!(await remoteTableExists(engine, alias, table))) {
        return blocked(
          `Table "${table}" not found in attached database "${alias}". ` +
          `Use connect_database result or list_datasets to see available tables.`,
          { error: "remote_table_not_found", alias, table }
        );
      }

      // ---- 2. 规模探测（COUNT pushdown）----
      let sourceCount: number;
      try {
        const r = await engine.query(
          `SELECT COUNT(*) FROM ${engine.quoteIdentifier(alias)}.${engine.quoteIdentifier(table)}`
        );
        sourceCount = Number(r.rows[0]?.[0] ?? 0);
      } catch (err) {
        return errorResult(
          `Failed to count remote table: ${err instanceof Error ? err.message : String(err)}`,
          { alias, table }
        );
      }

      const maxRows = rt.security.dbMaxMaterializeRows;
      let rowLimit: number | undefined;
      if (args.row_limit !== undefined && args.row_limit !== null) {
        if (!Number.isInteger(args.row_limit) || args.row_limit <= 0) {
          return blocked(`row_limit must be a positive integer, got ${String(args.row_limit)}.`, { error: "invalid_row_limit" });
        }
        if (args.row_limit > maxRows) {
          return blocked(
            `row_limit ${args.row_limit} exceeds the materialization hard limit ${maxRows}. ` +
            `Remedies: (1) set row_limit ≤ ${maxRows}; ` +
            `(2) raise the limit via env PI_DATA_AGENT_DB_MAX_MATERIALIZE_ROWS; ` +
            `(3) filter on the remote side first (WHERE via query_data) and materialize the subset.`,
            { error: "row_limit_exceeds_max", rowLimit: args.row_limit, maxRows }
          );
        }
        rowLimit = args.row_limit;
      }

      // ---- 3. 熔断：超限且无 row_limit → block（非 confirm）----
      if (rowLimit === undefined && sourceCount > maxRows) {
        return blocked(
          `Remote table ${alias}.${table} has ${sourceCount} rows, exceeding the hard materialization ` +
          `limit of ${maxRows} (PI_DATA_AGENT_DB_MAX_MATERIALIZE_ROWS). Blocked to protect the local ` +
          `.duckdb file and the remote server. Choose one of three remedies:\n` +
          `1. Pass row_limit (≤ ${maxRows}) to materialize only the first N rows;\n` +
          `2. Raise the limit: set env PI_DATA_AGENT_DB_MAX_MATERIALIZE_ROWS to a larger value;\n` +
          `3. Filter remotely first: run a WHERE query via query_data, then materialize the subset ` +
          `(e.g. narrow the source table or create a filtered copy first).`,
          { error: "row_count_exceeds_max", sourceCount, maxRows, alias, table }
        );
      }

      // ---- 4. 目标表 + 是否替换 ----
      const target = args.target_table?.trim() || defaultTargetName(alias, table);
      if (!IDENT_RE.test(target)) {
        return blocked(
          `Invalid target_table "${target}". Must match [A-Za-z_][A-Za-z0-9_]* ` +
          `(default is ${defaultTargetName(alias, table)}).`,
          { error: "invalid_target", target }
        );
      }
      const replaced = await localTableExists(engine, target);
      const effectiveRows = rowLimit !== undefined ? Math.min(rowLimit, sourceCount) : sourceCount;

      // ---- 5. 确认门（S-1 fail-closed）----
      const confirmMessage =
        `将远程表 ${alias}.${table} 物化到本地表 main.${target}\n` +
        `- 远端行数: ${sourceCount}${rowLimit !== undefined ? `（row_limit=${rowLimit}，实际物化 ${effectiveRows} 行）` : ""}\n` +
        `- 目标表: main.${target}${replaced ? "（⚠ 已存在，将被替换）" : "（新建）"}\n` +
        `- 操作为只读复制，不修改远程数据。`;
      const gate = resolveConfirmGate(confirmMessage, {
        autoConfirmWrite: rt.config.autoConfirmWrite,
        hasUi: Boolean(ctx.ui),
      });
      if (gate.action === "block") {
        return blocked(gate.reason, { error: "confirm_gate", alias, table, target, sourceCount });
      }
      let autoConfirmed = false;
      if (gate.action === "confirm") {
        const confirmed = await ctx.ui.confirm("Materialize Remote Table", gate.confirmMessage, { timeout: 120000 });
        if (!confirmed) {
          return {
            content: [{ type: "text", text: "Operation cancelled by user." }],
            details: { toolName: "materialize_remote_table", cancelled: true, alias, table, target },
          };
        }
      } else {
        autoConfirmed = true;
      }

      // ---- 6. tmp → rename 原子替换（RM-3：失败 ROLLBACK + DROP tmp）----
      const qTmp = engine.quoteIdentifier(TMP_TABLE);
      const qTarget = engine.quoteIdentifier(target);
      const dbSizeBefore = statSize(rt.config.dbPath);

      const limitSql = rowLimit !== undefined ? ` LIMIT ${rowLimit}` : "";
      try {
        await engine.exec(
          `CREATE TABLE main.${qTmp} AS SELECT * FROM ` +
          `${engine.quoteIdentifier(alias)}.${engine.quoteIdentifier(table)}${limitSql};`
        );
      } catch (err) {
        // CREATE 失败：清 tmp（可能半成品），target 从未被触碰
        try { await engine.exec(`DROP TABLE IF EXISTS main.${qTmp};`); } catch { /* 清理失败兜底 */ }
        return errorResult(
          `Materialization failed while copying remote table (target table untouched, no temp residue): ` +
          `${err instanceof Error ? err.message : String(err)}`,
          { alias, table, target }
        );
      }

      try {
        await engine.exec(
          `BEGIN; ` +
          `DROP TABLE IF EXISTS main.${qTarget}; ` +
          `ALTER TABLE main.${qTmp} RENAME TO ${qTarget}; ` +
          `COMMIT;`
        );
      } catch (swapErr) {
        // swap 失败：显式 ROLLBACK 恢复 target，再清 tmp（§0.3 已核验）
        try { await engine.exec("ROLLBACK;"); } catch { /* 无活动事务则忽略 */ }
        try { await engine.exec(`DROP TABLE IF EXISTS main.${qTmp};`); } catch { /* 清理失败兜底 */ }
        return errorResult(
          `Materialization failed during atomic swap (existing target restored, temp table removed): ` +
          `${swapErr instanceof Error ? swapErr.message : String(swapErr)}`,
          { alias, table, target }
        );
      }

      // ---- 7. 摘要：行数/列数/耗时/endpoint/体积/精度/字典 ----
      let actualRows: number;
      try {
        const r = await engine.query(`SELECT COUNT(*) FROM main.${qTarget}`);
        actualRows = Number(r.rows[0]?.[0] ?? 0);
      } catch {
        actualRows = effectiveRows;
      }
      let columnCount = 0;
      let sourceColumns: Array<{ name: string; type: string }> = [];
      try {
        // 远端原始类型优先（DECIMAL 精度只在这里），拿不到回退 DuckDB schema
        sourceColumns =
          (await fetchRemoteColumnTypes(engine, alias, table)) ??
          (await engine.getSchema(`${alias}.${table}`)).map((c) => ({ name: c.name, type: c.type }));
        columnCount = sourceColumns.length;
      } catch { /* schema 获取失败不影响物化结果 */ }

      const dbSizeAfter = statSize(rt.config.dbPath);
      const endpoint = resolveEndpoint(alias, dbInfo);

      // RM-4：字典静默生成（失败不影响物化结果）
      let dictionaryGenerated = false;
      const dict = rt.dataDictionary;
      if (dict && typeof dict.ensureDictionary === "function") {
        try {
          if (!dict.hasDictionary(target)) {
            await dict.ensureDictionary(target, engine);
            dictionaryGenerated = true;
          }
          await dict.refreshFingerprint(target, engine);
        } catch {
          // best-effort：字典失败不影响物化成功返回
        }
      }

      const decimalWarnings = findDecimalPrecisionWarnings(sourceColumns);
      const durationMs = Date.now() - startTime;

      const lines: string[] = [];
      lines.push(`Materialized ${alias}.${table} → main.${target}`);
      lines.push(
        `Rows: ${actualRows}` +
        (rowLimit !== undefined
          ? ` (row_limit=${rowLimit}, remote total=${sourceCount})`
          : ` (remote total=${sourceCount})`)
      );
      lines.push(`Columns: ${columnCount}`);
      lines.push(`Duration: ${durationMs}ms`);
      if (endpoint) lines.push(`Endpoint: ${endpoint} (credentials never shown)`);
      if (dbSizeBefore !== undefined && dbSizeAfter !== undefined) {
        lines.push(
          `Local .duckdb size: ${formatBytes(dbSizeBefore)} → ${formatBytes(dbSizeAfter)} (${formatBytes(dbSizeAfter - dbSizeBefore)})`
        );
      }
      lines.push(`Replaced existing table: ${replaced ? "yes" : "no"}`);
      if (autoConfirmed) lines.push("Confirmation: auto-confirmed (PI_DATA_AGENT_AUTO_CONFIRM_WRITE)");
      if (dictionaryGenerated) lines.push("已生成数据字典（ai-guessed），可用 confirm_dictionary 校正。");
      if (decimalWarnings.length > 0) {
        lines.push("⚠ DECIMAL 精度提示:");
        for (const w of decimalWarnings) lines.push(`  - ${w}`);
      }
      lines.push(`Query example: SELECT * FROM ${target} LIMIT 10`);

      // 物化记录 → Dashboard「本地副本」视图数据源（写入失败不影响物化结果）
      try {
        new MaterializationStore(join(rt.config.projectConfigDir, "materializations.json")).record({
          targetTable: target,
          alias,
          table,
          rows: actualRows,
          columns: columnCount,
          sourceRowCount: sourceCount,
          rowLimit,
          durationMs,
          endpoint,
          dbSizeBefore,
          dbSizeAfter,
          replaced,
          decimalWarnings,
          materializedAt: new Date().toISOString(),
        });
      } catch {
        // 记录缺失只影响视图展示，物化本身已成功
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          toolName: "materialize_remote_table",
          success: true,
          alias,
          table,
          targetTable: target,
          rows: actualRows,
          sourceRowCount: sourceCount,
          rowLimit,
          columns: columnCount,
          replaced,
          durationMs,
          endpoint,
          dbSizeBefore,
          dbSizeAfter,
          dictionaryGenerated,
          autoConfirmed,
          decimalWarnings,
        },
      };
    },
  };
}

/** .duckdb 当前体积（不存在时 undefined） */
function statSize(dbPath: string): number | undefined {
  try {
    return statSync(dbPath).size;
  } catch {
    return undefined;
  }
}

/** endpoint 摘要（无凭据：mysql 用注册表 endpoint，其余用 duckdb_databases().path，兜底脱敏） */
function resolveEndpoint(alias: string, dbInfo: { type: string; path: string }): string {
  const registered = getActiveRemoteConnections().find((c) => c.alias === alias);
  const raw = registered?.endpoint || (dbInfo.path ? `${dbInfo.type}: ${dbInfo.path}` : dbInfo.type);
  return redactCredentials(raw);
}

function formatBytes(n: number): string {
  const sign = n < 0 ? "-" : "";
  let v = Math.abs(n);
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${sign}${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}
