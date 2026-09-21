/**
 * Pi Data Agent — 远程数据库多方言基座（v0.12 M-4）
 *
 * 设计：
 * - 接一个新数据库 = 一份 RemoteDbDialect 配置 + 对称测试（阶段 3 加 postgres 即填表）
 * - attachRemote 固定五步：显式 INSTALL/LOAD → 超时 → temporary secret → ATTACH READ_ONLY → 无凭据摘要
 * - 凭据只进 CREATE SECRET 一条语句；永不拼进 ATTACH 连接串（调研 §4.5 实测：
 *   明文连接串 ATTACH 失败时异常文本含明文密码）
 * - 每一步失败都要清理半成品 secret，避免残留导致重连同名 alias 冲突
 *
 * 禁用路径（写死，勿改）：
 * - mysql_query() 表函数（DuckDB issue #65：DECIMAL 全 NULL）
 * - 明文连接串 ATTACH（ATTACH 'host=.. password=..'）
 */

import type { DuckDBEngine } from "./duckdb.js";

/** 远程数据库方言描述 */
export interface RemoteDbDialect {
  /** DuckDB ATTACH 的 TYPE 值（"mysql" | "postgres"） */
  type: "mysql" | "postgres";
  /** 需要显式 INSTALL/LOAD 的 DuckDB 扩展名 */
  extensionName: string;
  /** CREATE SECRET 的 TYPE 值 */
  secretType: string;
  /** 该方言 SET 参数前缀 */
  settingsPrefix: string;
  /** 默认端口 */
  defaultPort: number;
  /** 查询超时 SET 参数名；阶段 3 注意：pg_statement_timeout_millis 默认 null 必须显式设置 */
  timeoutSetting: string;
}

/**
 * 已注册方言表。v0.12 只注册 mysql；
 * postgres 留结构位（v0.14 阶段 3 接入时新增一行 + 对称测试即可）。
 */
export const REMOTE_DIALECTS: Record<string, RemoteDbDialect> = {
  mysql: {
    type: "mysql",
    extensionName: "mysql",
    secretType: "mysql",
    settingsPrefix: "mysql",
    defaultPort: 3306,
    timeoutSetting: "mysql_query_timeout_max_ms",
  },
  // postgres: 阶段 3 接入。届时必须显式设置 pg_statement_timeout_millis（默认 null 不限时）。
};

/** attachRemote 输入 */
export interface RemoteAttachSpec {
  dialect: RemoteDbDialect;
  /** DuckDB 中的 schema 别名（已归一化） */
  alias: string;
  host: string;
  port: number;
  database: string;
  user: string;
  /** 密码——只进 CREATE SECRET 语句，永不进返回文本/ATTACH 串/日志 */
  password: string;
  /** 查询超时毫秒（来自 config.dbQueryTimeoutMs） */
  timeoutMs: number;
}

/** attachRemote 结果——连接摘要，无凭据 */
export interface RemoteAttachResult {
  alias: string;
  /** 方言类型（"mysql"） */
  dialectType: string;
  /** host:port/database 摘要 */
  endpoint: string;
}

/** ensureExtensionLoaded 失败结果 */
export interface ExtensionLoadFailure {
  ok: false;
  /** 含降级指引的错误文案（可返回给模型/用户） */
  guidance: string;
}

/**
 * 显式 INSTALL + LOAD 扩展（v0.12 M-4/M-7 共用封装）
 *
 * 不再依赖 DuckDB 静默自动下载：离线/受限网络下显式失败，
 * 返回预置扩展的降级指引（预置路径格式 ~/.duckdb/extensions/<version>/<os>_<arch>/，
 * 或 SET extension_directory = '/path/to/extensions'）。
 */
export async function ensureExtensionLoaded(
  engine: DuckDBEngine,
  extensionName: string
): Promise<{ ok: true } | ExtensionLoadFailure> {
  try {
    await engine.exec(`INSTALL ${extensionName}`);
    await engine.exec(`LOAD ${extensionName}`);
    return { ok: true };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      guidance:
        `Failed to install/load DuckDB extension "${extensionName}" (common in offline or ` +
        `network-restricted environments). Remediation: pre-download the extension for your ` +
        `DuckDB version into ~/.duckdb/extensions/<duckdb_version>/<os>_<arch>/ ` +
        `(e.g. ~/.duckdb/extensions/v1.5.4/osx_arm64/${extensionName}.duckdb_extension), ` +
        `or SET extension_directory to a local directory containing it. ` +
        `Detail: ${raw.slice(0, 200)}`,
    };
  }
}

/** SQL 字符串字面量转义（' → ''） */
function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * 活跃远程连接注册表（v0.12 M-8：Dashboard 连接视图数据源）
 *
 * 进程内状态：扩展重启后注册表与 DuckDB 实例同时归零，天然一致。
 * key = alias。
 */
const activeRemoteConnections = new Map<string, RemoteAttachResult>();

/** 列出当前活跃远程连接（无凭据摘要） */
export function getActiveRemoteConnections(): RemoteAttachResult[] {
  return Array.from(activeRemoteConnections.values());
}

/** 从注册表移除（模型侧 DETACH 被拦截，正常只在引擎重连/关闭时对账） */
export function removeRemoteConnection(alias: string): void {
  activeRemoteConnections.delete(alias);
}

/**
 * 连接远程数据库（只读）——五步固定顺序封装
 *
 * 1. 显式 INSTALL + LOAD 方言扩展（失败返回降级指引）
 * 2. SET {timeoutSetting} = {timeoutMs}（失败即拒绝连接）
 * 3. CREATE OR REPLACE TEMPORARY SECRET（不落盘；password 只出现在这一条语句）
 * 4. ATTACH '' AS alias (TYPE ..., SECRET ..., READ_ONLY)——空连接串 + secret 引用
 * 5. 返回无凭据连接摘要
 *
 * 第 3/4 步任一失败：DROP SECRET 清理半成品后原样抛出（由调用方 redact 后返回）。
 */
export async function attachRemote(
  engine: DuckDBEngine,
  spec: RemoteAttachSpec
): Promise<RemoteAttachResult> {
  const { dialect, alias, host, port, database, user, password, timeoutMs } = spec;
  const q = (name: string) => engine.quoteIdentifier(name);

  // 1. 显式 INSTALL + LOAD
  const ext = await ensureExtensionLoaded(engine, dialect.extensionName);
  if (!ext.ok) {
    throw new Error(ext.guidance);
  }

  // 超时设置必须成功，才能创建凭据或发起远程连接。
  await engine.exec(`SET ${dialect.timeoutSetting} = ${Math.round(Number(timeoutMs))}`);

  const secretName = `pi_data_agent_${dialect.type}_${alias}`;

  try {
    // 3. temporary secret（凭据唯一入口；PORT 必须是数字字面量）
    const secretSql =
      `CREATE OR REPLACE TEMPORARY SECRET ${q(secretName)} (` +
      `TYPE ${dialect.secretType}, ` +
      `HOST '${escapeSqlString(host)}', ` +
      `PORT ${Math.round(Number(port))}, ` +
      `DATABASE '${escapeSqlString(database)}', ` +
      `USER '${escapeSqlString(user)}', ` +
      `PASSWORD '${escapeSqlString(password)}')`;
    await engine.exec(secretSql);

    // 4. ATTACH READ_ONLY（secret 引用，连接串留空）
    const attachSql =
      `ATTACH '' AS ${q(alias)} ` +
      `(TYPE ${dialect.type}, SECRET ${q(secretName)}, READ_ONLY)`;
    await engine.exec(attachSql);
  } catch (err) {
    // 失败清理半成品 secret（temporary secret 随会话存续，不清理会残留）
    try {
      await engine.exec(`DROP SECRET IF EXISTS ${q(secretName)}`);
    } catch {
      // 清理失败不掩盖原始连接错误
    }
    throw err;
  }

  // 5. 无凭据摘要
  const result: RemoteAttachResult = {
    alias,
    dialectType: dialect.type,
    endpoint: `${host}:${port}/${database}`,
  };
  activeRemoteConnections.set(alias, result);
  return result;
}

/**
 * 检查别名是否已被占用（v0.12 M-5：冲突报错，不做静默 DETACH 换连）
 *
 * @returns true = 别名已被某个已 attach 的数据库占用
 */
export async function isAliasTaken(engine: DuckDBEngine, alias: string): Promise<boolean> {
  const result = await engine.query(
    `SELECT COUNT(*)::INT AS c FROM duckdb_databases() ` +
    `WHERE database_name = '${escapeSqlString(alias)}'`
  );
  const cnt = result.rows.length > 0 ? Number(result.rows[0][0]) : 0;
  return cnt > 0;
}
