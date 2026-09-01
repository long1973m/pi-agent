/**
 * S5.1 connect_database — 连接 SQLite 文件 / MySQL 远程库（v0.12 M-5/M-7）
 *
 * 流程：
 * 1. db_type 分流（sqlite | mysql）
 * 2. sqlite：路径白名单 → 文件存在性 → alias → 显式 INSTALL sqlite → ATTACH
 * 3. mysql：参数校验 → 远程白名单（M-2）→ 凭据四级解析 → alias 冲突检查 →
 *    attachRemote（M-4：INSTALL→secret→ATTACH READ_ONLY→超时）→ 枚举表
 * 4. attach 失败不影响 CSV 主流程（独立错误处理）
 *
 * 安全红线（v0.12）：
 * - 参数 schema 禁止出现 password 字段（工具参数整体进 LLM context）
 * - 密码只进 temporary secret；所有错误文本经 redactCredentials 脱敏
 * - 连接强制 READ_ONLY；写入应拒绝（服务端仍需 GRANT SELECT ONLY 账号）
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ToolRegisterParams } from "./tool-context.js";
import { redactCredentials } from "../security.js";
import {
  REMOTE_DIALECTS,
  attachRemote,
  ensureExtensionLoaded,
  isAliasTaken,
} from "../engine/remote-dialect.js";

/** connect_database 参数（注意：禁止添加 password 字段——参数整体进 LLM context） */
const ConnectDatabaseParams = Type.Object({
  db_type: Type.String({
    description: "Database type: 'sqlite' (local file) or 'mysql' (remote, read-only).",
    default: "sqlite",
  }),
  file_path: Type.Optional(Type.String({
    description: "SQLite database file path (.db / .sqlite / .sqlite3). Required when db_type=sqlite.",
  })),
  host: Type.Optional(Type.String({
    description: "MySQL host. Required when db_type=mysql. Must be in dbAllowedHosts whitelist.",
  })),
  port: Type.Optional(Type.Number({
    description: "MySQL port. Optional, default 3306.",
  })),
  user: Type.Optional(Type.String({
    description: "MySQL user name. Required when db_type=mysql.",
  })),
  database: Type.Optional(Type.String({
    description: "MySQL database name. Required when db_type=mysql.",
  })),
  alias: Type.Optional(Type.String({
    description: "DuckDB schema alias (optional; sqlite: derived from file name, mysql: derived from database_host).",
  })),
});

/** attach 后枚举表与 schema（sqlite/mysql 共用的三级 fallback，v0.12 M-5 抽取） */
async function enumerateAttachedTables(
  rt: NonNullable<ReturnType<ToolRegisterParams["getRuntime"]>>,
  alias: string
): Promise<Array<{ name: string; columns: Array<{ name: string; type: string }> }>> {
  let tableNames: string[] = [];
  try {
    const r1 = await rt.engine!.executeQueryWithLimit(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = '${alias.replace(/'/g, "''")}' ORDER BY table_name`
    );
    tableNames = r1.rows.map((r) => String(r[0]));
  } catch {
    tableNames = [];
  }
  if (tableNames.length === 0) {
    try {
      const r2 = await rt.engine!.executeQueryWithLimit(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_catalog = '${alias.replace(/'/g, "''")}' ORDER BY table_name`
      );
      tableNames = r2.rows.map((r) => String(r[0]));
    } catch {
      tableNames = [];
    }
  }
  if (tableNames.length === 0) {
    try {
      const r3 = await rt.engine!.executeQueryWithLimit(
        `SHOW TABLES FROM ${rt.engine!.quoteIdentifier(alias)}`
      );
      tableNames = r3.rows.map((r) => String(r[0]));
    } catch {
      tableNames = [];
    }
  }

  const tableSchemas: Array<{ name: string; columns: Array<{ name: string; type: string }> }> = [];
  for (const tableName of tableNames) {
    try {
      const schema = await rt.engine!.getSchema(`${alias}.${tableName}`);
      tableSchemas.push({
        name: tableName,
        columns: schema.map((c) => ({ name: c.name, type: c.type })),
      });
    } catch (schemaErr) {
      tableSchemas.push({
        name: tableName,
        columns: [{ name: "<error>", type: String(schemaErr) }],
      });
    }
  }
  return tableSchemas;
}

/** 归一化 schema 别名：仅字母数字下划线，不以数字开头 */
function normalizeAlias(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** 从 ExtensionContext 交互输入密码（无 UI / headless 时返回 null） */
async function promptForPassword(ctx: ExtensionContext, user: string, host: string): Promise<string | null> {
  try {
    const ui = (ctx as { ui?: { input?: (title: string, placeholder?: string) => Promise<string | undefined> } }).ui;
    if (!ui || typeof ui.input !== "function") return null;
    const value = await ui.input(`MySQL password for ${user}@${host}`, "password");
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * MySQL 凭据四级解析（fail-closed，v0.12 §6.2）
 *
 * 1. env PI_DATA_AGENT_MYSQL_PWD（项目命名空间，两者都设时优先——避免用户 shell 里
 *    指向其他用途的 MYSQL_PWD 被误用）
 * 2. env MYSQL_PWD（DuckDB 扩展原生识别，用户现有习惯零迁移）
 * 3. 交互模式 ctx.ui 输入（结果仅存入 temporary secret）
 * 4. 全部缺失 → null（调用方 block，文案说明三种配置方式）
 */
function resolveMysqlPassword(
  ctx: ExtensionContext,
  user: string,
  host: string
): Promise<string | null> {
  const fromProjectEnv = process.env.PI_DATA_AGENT_MYSQL_PWD;
  if (fromProjectEnv && fromProjectEnv.length > 0) return Promise.resolve(fromProjectEnv);
  const fromNativeEnv = process.env.MYSQL_PWD;
  if (fromNativeEnv && fromNativeEnv.length > 0) return Promise.resolve(fromNativeEnv);
  return promptForPassword(ctx, user, host);
}

export function createConnectDatabaseTool(params: ToolRegisterParams): ToolDefinition {
  return {
    name: "connect_database",
    label: "Connect Database",
    description:
      "Connect to a database via DuckDB ATTACH. Supports: (1) db_type=sqlite — local SQLite file; " +
      "(2) db_type=mysql — remote MySQL server, READ-ONLY connection (forced READ_ONLY; use a " +
      "GRANT SELECT ONLY server account). MySQL requires the host to be whitelisted in " +
      "PI_DATA_AGENT_DB_ALLOWED_HOSTS, and the password must be provided via env " +
      "PI_DATA_AGENT_MYSQL_PWD or MYSQL_PWD (never passed as a tool parameter). " +
      "Connection only — writes to remote databases are not supported and such requests must be refused. " +
      "Returns attached schema alias and table list. If attach fails, returns error without affecting CSV main workflow.",
    parameters: ConnectDatabaseParams,
    execute: async (
      toolCallId: string,
      args: {
        db_type: string;
        file_path?: string;
        host?: string;
        port?: number;
        user?: string;
        database?: string;
        alias?: string;
      },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      const rt = params.getRuntime();
      if (!rt) {
        return {
          content: [{ type: "text", text: "Error: Runtime not available." }],
          details: { toolName: "connect_database", error: "runtime not available" },
        };
      }

      const dbType = args.db_type.toLowerCase();
      if (dbType !== "sqlite" && dbType !== "mysql") {
        return {
          content: [{ type: "text", text: `Error: Unsupported database type "${args.db_type}". Supported: "sqlite", "mysql".` }],
          details: { toolName: "connect_database", error: "unsupported_db_type", supportedTypes: ["sqlite", "mysql"] },
        };
      }

      const security = rt.security;
      return dbType === "mysql"
        ? connectMysql(rt, security, args, ctx)
        : connectSqlite(rt, security, args);
    },
  };
}

// ==========================================================================
// sqlite 分支（行为与 v0.11 兼容 + M-7 显式 INSTALL）
// ==========================================================================

async function connectSqlite(
  rt: NonNullable<ReturnType<ToolRegisterParams["getRuntime"]>>,
  security: NonNullable<ReturnType<ToolRegisterParams["getRuntime"]>>["security"],
  args: { file_path?: string; alias?: string }
): Promise<AgentToolResult<unknown>> {
  const filePath = args.file_path ?? "";

  // 路径白名单检查
  const pathCheck = security.checkPath(filePath);
  if (pathCheck.action === "block") {
    return {
      content: [{ type: "text", text: `Security blocked: ${pathCheck.reason}` }],
      details: { toolName: "connect_database", blocked: true, reason: pathCheck.reason },
    };
  }

  // 文件存在性检查
  if (!existsSync(filePath)) {
    return {
      content: [{ type: "text", text: `Error: Database file not found: ${filePath}` }],
      details: { toolName: "connect_database", error: "file_not_found", filePath },
    };
  }

  // 生成 alias
  const alias = (args.alias && normalizeAlias(args.alias)) ||
    normalizeAlias(basename(filePath).replace(/\.[^.]+$/, ""));

  if (!alias || alias.match(/^[0-9]/)) {
    return {
      content: [{ type: "text", text: `Error: Invalid alias "${alias}". Must start with a letter and contain only letters, digits, and underscores.` }],
      details: { toolName: "connect_database", error: "invalid_alias", alias },
    };
  }

  try {
    // M-7: 显式 INSTALL + LOAD sqlite（失败不硬阻断——保留 ATTACH 自动加载 fallback）
    const ext = await ensureExtensionLoaded(rt.engine!, "sqlite");
    const sqliteGuidance = ext.ok ? null : ext.guidance;

    // alias 已存在则先 DETACH（sqlite 分支保持 v0.11 行为）
    try {
      await rt.engine!.exec(`DETACH DATABASE IF EXISTS ${rt.engine!.quoteIdentifier(alias)}`);
    } catch {
      // DETACH 失败通常是因为 alias 不存在，忽略
    }

    const attachSql = `ATTACH DATABASE '${filePath.replace(/'/g, "''")}' AS ${rt.engine!.quoteIdentifier(alias)} (TYPE SQLITE)`;
    try {
      await rt.engine!.exec(attachSql);
    } catch (attachErr) {
      // 显式 INSTALL 已失败且 ATTACH 也失败 → 附降级指引
      const baseMsg = `Failed to attach database: ${attachErr instanceof Error ? attachErr.message : String(attachErr)}`;
      return {
        content: [{ type: "text", text: redactCredentials(sqliteGuidance ? `${baseMsg}\n${sqliteGuidance}` : baseMsg) }],
        details: { toolName: "connect_database", error: redactCredentials(baseMsg), filePath, alias },
      };
    }

    // 枚举表与 schema（三级 fallback 与 mysql 共用）
    const tableSchemas = await enumerateAttachedTables(rt, alias);
    const schemaLines = tableSchemas.map((t) => {
      const colLines = t.columns.map((c) => `    - ${c.name}: ${c.type}`).join("\n");
      return `  - ${t.name}\n${colLines}`;
    }).join("\n");

    const text =
      `Connected to SQLite database: ${filePath}\n` +
      `Alias (schema): ${alias}\n` +
      `Tables: ${tableSchemas.length}\n\n` +
      `Table schemas:\n${schemaLines}\n\n` +
      `Query example: SELECT * FROM ${alias}.table_name LIMIT 10`;

    return {
      content: [{ type: "text", text }],
      details: {
        toolName: "connect_database",
        success: true,
        dbType: "sqlite",
        filePath,
        alias,
        tableCount: tableSchemas.length,
        tables: tableSchemas,
      },
    };
  } catch (err) {
    const errorMsg = `Failed to attach database: ${err instanceof Error ? err.message : String(err)}`;
    return {
      content: [{ type: "text", text: redactCredentials(errorMsg) }],
      details: {
        toolName: "connect_database",
        error: redactCredentials(errorMsg),
        filePath,
        alias,
      },
    };
  }
}

// ==========================================================================
// mysql 分支（v0.12 M-5）
// ==========================================================================

async function connectMysql(
  rt: NonNullable<ReturnType<ToolRegisterParams["getRuntime"]>>,
  security: NonNullable<ReturnType<ToolRegisterParams["getRuntime"]>>["security"],
  args: { host?: string; port?: number; user?: string; database?: string; alias?: string },
  ctx: ExtensionContext
): Promise<AgentToolResult<unknown>> {
  const blocked = (
    reason: string,
    details: Record<string, unknown> = {}
  ): AgentToolResult<unknown> => ({
    content: [{ type: "text", text: reason }],
    details: { toolName: "connect_database", blocked: true, ...details },
  });

  // 1. 参数校验（schema 无 password 字段——密码走 env/交互，见 §6.2）
  const host = (args.host ?? "").trim();
  const user = (args.user ?? "").trim();
  const database = (args.database ?? "").trim();
  const port = typeof args.port === "number" && Number.isFinite(args.port) && args.port > 0
    ? Math.round(args.port)
    : REMOTE_DIALECTS.mysql.defaultPort;

  if (!host || !user || !database) {
    return blocked(
      "Error: mysql connection requires non-empty 'host', 'user' and 'database' parameters.",
      { error: "missing_required_params", missing: [!host && "host", !user && "user", !database && "database"].filter(Boolean) }
    );
  }

  // 2. 远程目标白名单（M-2，fail-closed：block 即止，无 confirm 态）
  const remoteCheck = security.checkRemoteTarget(host, port);
  if (remoteCheck.action === "block") {
    return blocked(
      `Security blocked: ${remoteCheck.reason}`,
      { reason: remoteCheck.reason, host, port }
    );
  }

  // 3. alias：显式指定或 {database}_{host} 归一化；冲突报错（不做静默 DETACH 换连）
  const alias = (args.alias && normalizeAlias(args.alias)) ||
    normalizeAlias(`${database}_${host}`);
  if (!alias || alias.match(/^[0-9]/)) {
    return {
      content: [{ type: "text", text: `Error: Invalid alias "${alias}". Must start with a letter and contain only letters, digits, and underscores.` }],
      details: { toolName: "connect_database", error: "invalid_alias", alias },
    };
  }
  if (await isAliasTaken(rt.engine!, alias)) {
    return blocked(
      `Error: alias "${alias}" is already attached. Pass an explicit different 'alias' parameter ` +
      `(silent DETACH-and-reconnect is intentionally not performed).`,
      { error: "alias_conflict", alias }
    );
  }

  // 4. 凭据四级解析（PI_DATA_AGENT_MYSQL_PWD > MYSQL_PWD > 交互输入 > block）
  const password = await resolveMysqlPassword(ctx, user, host);
  if (!password) {
    return blocked(
      "Error: no MySQL password available (headless environment). Configure it in one of three ways:\n" +
      "1. env PI_DATA_AGENT_MYSQL_PWD=<password> (project namespace, takes precedence)\n" +
      "2. env MYSQL_PWD=<password> (recognized natively by the DuckDB mysql extension)\n" +
      "3. Run in interactive mode so a password dialog can be shown.\n" +
      "Note: passwords are never accepted as tool parameters (they would leak into the model context).",
      { error: "no_credentials" }
    );
  }

  // 5. attachRemote（M-4 五步封装：INSTALL → secret → ATTACH READ_ONLY → 超时）
  let attachResult;
  try {
    attachResult = await attachRemote(rt.engine!, {
      dialect: REMOTE_DIALECTS.mysql,
      alias,
      host,
      port,
      database,
      user,
      password,
      timeoutMs: security.dbQueryTimeoutMs,
    });
  } catch (err) {
    // 错误文本统一脱敏（M-6）——secret 路径本不含密码，此处兜底防御性脱敏
    const raw = err instanceof Error ? err.message : String(err);
    const errorMsg = `Failed to connect to MySQL ${host}:${port}/${database}: ${raw}`;
    return {
      content: [{ type: "text", text: redactCredentials(errorMsg) }],
      details: {
        toolName: "connect_database",
        error: redactCredentials(errorMsg),
        host,
        port,
        database,
        alias,
      },
    };
  }

  // 6. 枚举表与 schema（三级 fallback 与 sqlite 共用）
  const tableSchemas = await enumerateAttachedTables(rt, alias);
  const schemaLines = tableSchemas.map((t) => {
    const colLines = t.columns.map((c) => `    - ${c.name}: ${c.type}`).join("\n");
    return `  - ${t.name}\n${colLines}`;
  }).join("\n");

  const text =
    `Connected to MySQL database (READ-ONLY): ${attachResult.endpoint}\n` +
    `Alias (schema): ${attachResult.alias}\n` +
    `Tables: ${tableSchemas.length}\n\n` +
    `Table schemas:\n${schemaLines}\n\n` +
    `Query example: SELECT * FROM ${attachResult.alias}.table_name LIMIT 10\n\n` +
    `IMPORTANT: This connection is forced READ_ONLY. Writes to the remote database are not ` +
    `supported — refuse any write requests. The server-side account should also be ` +
    `GRANT SELECT ONLY (client READ_ONLY alone is not a security boundary).`;

  return {
    content: [{ type: "text", text }],
    details: {
      toolName: "connect_database",
      success: true,
      dbType: "mysql",
      alias: attachResult.alias,
      endpoint: attachResult.endpoint,
      readOnly: true,
      tableCount: tableSchemas.length,
      tables: tableSchemas,
    },
  };
}
