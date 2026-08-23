/**
 * S5.1 connect_database — 连接本地 SQLite 数据库
 *
 * 流程：
 * 1. db_type 校验（仅支持 sqlite）
 * 2. 路径白名单检查（复用 SecurityChecker）
 * 3. 文件存在性检查
 * 4. 生成 alias（用户指定或从文件名推导）
 * 5. DuckDB ATTACH 执行
 * 6. 查询 schema / tables
 * 7. attach 失败不影响 CSV 主流程（独立错误处理）
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ToolRegisterParams } from "./tool-context.js";

/** connect_database 参数 */
const ConnectDatabaseParams = Type.Object({
  db_type: Type.String({
    description: "数据库类型，目前仅支持 'sqlite'",
    default: "sqlite",
  }),
  file_path: Type.String({
    description: "SQLite 数据库文件路径（.db / .sqlite / .sqlite3）",
  }),
  alias: Type.Optional(Type.String({
    description: "DuckDB 中的 schema 别名（可选，默认从文件名生成）",
  })),
});

export function createConnectDatabaseTool(params: ToolRegisterParams): ToolDefinition {
  return {
    name: "connect_database",
    label: "Connect Database",
    description:
      "Connect to a local SQLite database file via DuckDB ATTACH. " +
      "Only supports SQLite. Performs path whitelist check and file existence validation. " +
      "Returns attached schema alias and table list. " +
      "If attach fails, returns error without affecting CSV main workflow.",
    parameters: ConnectDatabaseParams,
    execute: async (
      toolCallId: string,
      args: { db_type: string; file_path: string; alias?: string },
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

      // ======================================================================
      // 1. db_type 校验
      // ======================================================================
      const dbType = args.db_type.toLowerCase();
      if (dbType !== "sqlite") {
        return {
          content: [{ type: "text", text: `Error: Unsupported database type "${args.db_type}". Only "sqlite" is supported.` }],
          details: { toolName: "connect_database", error: "unsupported_db_type", supportedTypes: ["sqlite"] },
        };
      }

      const filePath = args.file_path;
      const security = rt.security;

      // ======================================================================
      // 2. 路径白名单检查
      // ======================================================================
      const pathCheck = security.checkPath(filePath);
      if (pathCheck.action === "block") {
        return {
          content: [{ type: "text", text: `Security blocked: ${pathCheck.reason}` }],
          details: { toolName: "connect_database", blocked: true, reason: pathCheck.reason },
        };
      }

      // ======================================================================
      // 3. 文件存在性检查
      // ======================================================================
      if (!existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `Error: Database file not found: ${filePath}` }],
          details: { toolName: "connect_database", error: "file_not_found", filePath },
        };
      }

      // ======================================================================
      // 4. 生成 alias
      // ======================================================================
      const alias = args.alias?.replace(/[^a-zA-Z0-9_]/g, "_") ||
        basename(filePath).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_]/g, "_");

      if (!alias || alias.match(/^[0-9]/)) {
        return {
          content: [{ type: "text", text: `Error: Invalid alias "${alias}". Must start with a letter and contain only letters, digits, and underscores.` }],
          details: { toolName: "connect_database", error: "invalid_alias", alias },
        };
      }

      // ======================================================================
      // 5. DuckDB ATTACH 执行
      // ======================================================================
      try {
        // 5a: 如果 alias 已存在，先 DETACH
        try {
          await rt.engine!.exec(`DETACH DATABASE IF EXISTS ${rt.engine!.quoteIdentifier(alias)}`);
        } catch {
          // DETACH 失败通常是因为 alias 不存在，忽略
        }

        // 5b: 执行 ATTACH
        const attachSql = `ATTACH DATABASE '${filePath.replace(/'/g, "''")}' AS ${rt.engine!.quoteIdentifier(alias)} (TYPE SQLITE)`;
        await rt.engine!.exec(attachSql);

        // ======================================================================
        // 6. 查询 schema / tables
        // ======================================================================
        // DuckDB sqlite attach 后，表可能在 information_schema 中 schema 为 'main'
        // 先尝试用 alias 查询，fallback 到 main
        let tableNames: string[] = [];
        try {
          const r1 = await rt.engine!.executeQueryWithLimit(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = '${alias}' ORDER BY table_name`
          );
          tableNames = r1.rows.map((r) => String(r[0]));
        } catch {
          tableNames = [];
        }
        if (tableNames.length === 0) {
          try {
            const r2 = await rt.engine!.executeQueryWithLimit(
              `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_catalog = '${alias}' ORDER BY table_name`
            );
            tableNames = r2.rows.map((r) => String(r[0]));
          } catch {
            tableNames = [];
          }
        }
        // 如果仍为空，尝试 SHOW TABLES FROM alias
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

        // 获取每个表的 schema
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

        // ======================================================================
        // 7. 构建返回结果
        // ======================================================================
        const schemaLines = tableSchemas.map((t) => {
          const colLines = t.columns.map((c) => `    - ${c.name}: ${c.type}`).join("\n");
          return `  - ${t.name}\n${colLines}`;
        }).join("\n");

        const text =
          `Connected to SQLite database: ${filePath}\n` +
          `Alias (schema): ${alias}\n` +
          `Tables: ${tableNames.length}\n\n` +
          `Table schemas:\n${schemaLines}\n\n` +
          `Query example: SELECT * FROM ${alias}.table_name LIMIT 10`;

        return {
          content: [{ type: "text", text }],
          details: {
            toolName: "connect_database",
            success: true,
            dbType,
            filePath,
            alias,
            tableCount: tableNames.length,
            tables: tableSchemas,
          },
        };
      } catch (err) {
        const errorMsg = `Failed to attach database: ${err instanceof Error ? err.message : String(err)}`;
        return {
          content: [{ type: "text", text: errorMsg }],
          details: {
            toolName: "connect_database",
            error: errorMsg,
            filePath,
            alias,
          },
        };
      }
    },
  };
}
