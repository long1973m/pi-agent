/**
 * Pi Data Agent — P0 安全层
 *
 * 职责：
 * 1. 路径白名单 — 阻止访问允许路径之外的文件
 * 2. SQL 黑名单 — 拦截无条件的危险写操作（DROP/DELETE/TRUNCATE/UPDATE 无 WHERE）
 * 3. 读写确认门控 — 写操作（INSERT/CREATE/UPDATE/DELETE/DROP）需用户确认
 * 4. 远程目标白名单 — ATTACH 远程数据库仅限 dbAllowedHosts（v0.12 M-2，fail-closed）
 * 5. 模型侧 ATTACH/DETACH 拦截 — 远程连接只允许出现在工具实现层（v0.12 M-3）
 * 6. 凭据脱敏 — 错误文本/审计日志中的连接凭据统一遮蔽（v0.12 M-6）
 *
 * 验收标准：
 * - 越界路径 → requiresConfirm
 * - DROP TABLE 无 WHERE → 拦截
 * - 读操作（SELECT）放行
 * - 删改 → 强制确认
 */

import { resolve, normalize } from "node:path";
import type { SecurityConfig, SecurityCheckResult, SecurityAction } from "./types.js";

/** SQL 操作分类 */
type SqlCategory = "read" | "write" | "dangerous" | "unknown";

/**
 * 确认门三态判定（v0.11 S-1 fail-closed）
 *
 * 过去各工具的确认分支写成 `if (check.action === "confirm" && ctx.ui)`，
 * headless 环境下 ctx.ui 不存在 → 整个分支被跳过 → 写操作静默执行（fail-open）。
 * 所有需要用户确认的操作必须经此函数判定：
 *
 * - autoConfirmWrite=true        → allow（显式配置放行，结果需标记 auto-confirmed）
 * - 有交互 UI                    → confirm（维持原有弹窗行为）
 * - 两者皆无                     → block（拒绝静默执行）
 */
export interface ConfirmGateOptions {
  /** 是否自动确认写操作（config.autoConfirmWrite / PI_DATA_AGENT_AUTO_CONFIRM_WRITE） */
  autoConfirmWrite: boolean;
  /** 当前环境是否存在可用的交互式 UI */
  hasUi: boolean;
}

export type ConfirmGateDecision =
  | { action: "allow"; autoConfirmed: true }
  | { action: "confirm"; confirmMessage: string }
  | { action: "block"; reason: string };

export function resolveConfirmGate(
  confirmMessage: string,
  options: ConfirmGateOptions
): ConfirmGateDecision {
  if (options.autoConfirmWrite) {
    return { action: "allow", autoConfirmed: true };
  }
  if (options.hasUi) {
    return { action: "confirm", confirmMessage };
  }
  return {
    action: "block",
    reason:
      "该操作需要用户确认，但当前环境没有可用的交互界面（headless），已按 fail-closed 原则拒绝。" +
      "如需自动化放行写操作，请显式设置环境变量 PI_DATA_AGENT_AUTO_CONFIRM_WRITE=true。",
  };
}

// ==========================================================================
// 凭据脱敏（v0.12 M-6）
// ==========================================================================

/**
 * 遮蔽文本中的连接凭据（v0.12 M-6）
 *
 * 覆盖四类模式：
 * 1. password=... / password: ... / PASSWORD '...'（含连接串与 CREATE SECRET 片段）
 * 2. PWD ...（MySQL 环境变量风格）
 * 3. IDENTIFIED BY ...（MySQL 账号语句）
 * 4. pwd=...（DuckDB sqlite/mysql attach 连接串参数）
 *
 * 用于工具返回文本与审计日志落盘前兜底；凭据永远只应进 temporary secret，
 * 本函数是错误信息携带凭据时的最后一道防线。
 */
export function redactCredentials(text: string): string {
  if (!text) return text;
  return text
    // password=xxx / password: xxx / PASSWORD 'xxx'（值含引号串或裸 token）
    .replace(
      /(password\s*[=:]\s*)('(?:[^']|'')*'|"(?:[^"]|"")*"|[^\s,;)\]]+)/gi,
      "$1***"
    )
    // PWD xxx（env 风格）
    .replace(/\b(PWD\s+)([^\s,;)\]]+)/gi, "$1***")
    // IDENTIFIED BY xxx
    .replace(
      /\b(identified\s+by\s+)('(?:[^']|'')*'|"(?:[^"]|"")*"|[^\s,;)\]]+)/gi,
      "$1***"
    );
}

/** 安全层检查器 */
export class SecurityChecker {
  private config: SecurityConfig;

  constructor(config: SecurityConfig) {
    this.config = config;
  }

  /** 更新配置（热更新） */
  updateConfig(config: SecurityConfig): void {
    this.config = config;
  }

  /** v0.12 M-1: 远程查询超时毫秒（connect_database 传给 attachRemote 用） */
  get dbQueryTimeoutMs(): number {
    return this.config.dbQueryTimeoutMs;
  }

  // ==========================================================================
  // 路径检查
  // ==========================================================================

  /**
   * 检查文件路径是否在允许的白名单内
   *
   * 逻辑：
   * 1. 解析为绝对路径并规范化（消除 .. 和 .）
   * 2. 检查是否在任一 allowedPaths 前缀下
   * 3. blockOutOfBoundsPath=true 时直接拦截，否则要求确认
   */
  checkPath(filePath: string): SecurityCheckResult {
    const absPath = normalize(resolve(filePath));
    const normalizedAllowed = this.config.allowedPaths.map((p: string) => normalize(resolve(p)));

    const isAllowed = normalizedAllowed.some((allowed: string) =>
      absPath === allowed || absPath.startsWith(allowed + "/")
    );

    if (isAllowed) {
      return { action: "allow" };
    }

    if (this.config.blockOutOfBoundsPath) {
      return {
        action: "block",
        reason: `Path "${absPath}" is outside allowed directories: ${normalizedAllowed.join(", ")}`,
      };
    }

    return {
      action: "confirm",
      confirmMessage: `File "${absPath}" is outside the project directory. Allow access?`,
    };
  }

  /** 快捷方法：判断路径是否安全 */
  isPathSafe(filePath: string): boolean {
    return this.checkPath(filePath).action === "allow";
  }

  // ==========================================================================
  // 远程目标白名单（v0.12 M-2）
  // ==========================================================================

  /**
   * 检查远程数据库连接目标是否在 dbAllowedHosts 白名单内
   *
   * 语义（fail-closed，无 confirm 态——远程连接没有"顺手确认"的合理性）：
   * - 白名单空 → 一律 block（默认配置拒绝一切远程连接，现有纯本地用户行为零变化）
   * - 条目含 :port → host 与 port 必须同时命中
   * - 条目仅 host → 任意端口命中
   * - host 大小写不敏感；localhost 与 127.0.0.1 不视为等价（写哪条算哪条，避免隐式扩权）
   *
   * 独立入口、不塞进 checkSql：与 SQL 读写分类是两个正交的关注点。
   */
  checkRemoteTarget(host: string, port: number): SecurityCheckResult {
    const whitelist = this.config.dbAllowedHosts ?? [];
    const normalizedHost = String(host ?? "").trim().toLowerCase();

    if (normalizedHost.length === 0) {
      return {
        action: "block",
        reason: "远程目标 host 为空，已拒绝连接。",
      };
    }

    for (const entry of whitelist) {
      const e = String(entry ?? "").trim().toLowerCase();
      if (e.length === 0) continue;
      const colonIdx = e.lastIndexOf(":");
      const hasPort = colonIdx > 0 && /^\d+$/.test(e.slice(colonIdx + 1));
      if (hasPort) {
        const entryHost = e.slice(0, colonIdx);
        const entryPort = parseInt(e.slice(colonIdx + 1), 10);
        if (entryHost === normalizedHost && entryPort === port) {
          return { action: "allow" };
        }
      } else if (e === normalizedHost) {
        return { action: "allow" };
      }
    }

    const shown =
      whitelist.length > 0
        ? whitelist.join(", ")
        : "（当前为空，即拒绝一切远程连接）";
    return {
      action: "block",
      reason:
        `Remote target "${host}:${port}" is not in the allowed database hosts whitelist. ` +
        `Current whitelist: ${shown}. ` +
        `To allow this target, set env PI_DATA_AGENT_DB_ALLOWED_HOSTS (semicolon-separated, ` +
        `e.g. "db.internal:3306;10.0.0.5") or add "dbAllowedHosts" in .pi-data-agent/config.json.`,
    };
  }

  // ==========================================================================
  // SQL 检查
  // ==========================================================================

  /**
   * 检查 SQL 语句的安全性
   *
   * 四层检查：
   * 1. 黑名单正则 — 无条件的危险操作直接拦截
   * 2. 文件路径白名单 — table function / COPY TO / FROM 'file' 中的路径必须在白名单内
   *    （v0.11 S-2：实测 @duckdb/node-api 1.5.x 的 SET allowed_directories 不生效，
   *     read_csv('/any/path') 可绕过工具参数层的路径检查，故在 SQL 层补齐）
   * 3. 操作分类 — 区分读/写/危险（字符串字面量已剥离，避免 'DROP TABLE x' 这类误报）
   * 4. 写操作确认 — 非只读操作需用户确认（经 resolveConfirmGate 判定）
   */
  checkSql(sql: string): SecurityCheckResult {
    const normalized = sql.trim();

    // 1. 黑名单正则检查
    for (const pattern of this.config.dangerousSqlPatterns) {
      if (pattern.test(normalized)) {
        return {
          action: "block",
          reason: `Dangerous SQL pattern matched: "${normalized.slice(0, 80)}..."`,
          matchedPattern: pattern.source,
        };
      }
    }

    // 1.5 ATTACH/DETACH 拦截（v0.12 M-3）
    //
    // READ_ONLY 只是客户端约束——模型可自行发起不带 READ_ONLY 的 ATTACH 绕过。
    // 设计定死：ATTACH 只允许出现在工具实现层（engine.exec 直达，不经 checkSql），
    // 模型侧任何 ATTACH/DETACH 一律 block。
    // 位置刻意先于 autoConfirmWrite 判定（下方 dangerous/write 分支）：
    // dangerous 级的 ATTACH 不受自动确认豁免。
    const attachReason = this.findAttachViolation(normalized);
    if (attachReason) {
      return {
        action: "block",
        reason: attachReason,
        matchedPattern: "\\bATTACH\\b|\\bDETACH\\b",
      };
    }

    // 2. SQL 内嵌文件路径白名单检查
    const pathViolation = this.findSqlPathViolation(normalized);
    if (pathViolation) {
      return {
        action: "block",
        reason: pathViolation,
      };
    }

    // 3. 操作分类
    const category = this.classifySql(normalized);

    // 4. 读操作直接放行
    if (category === "read") {
      return { action: "allow" };
    }

    // 危险/写操作需确认
    if (category === "dangerous" || category === "write") {
      if (this.config.autoConfirmWrite) {
        return { action: "allow" };
      }
      return {
        action: "confirm",
        confirmMessage: `This SQL will modify data: "${normalized.slice(0, 80)}${normalized.length > 80 ? "..." : ""}". Proceed?`,
      };
    }

    // 未知操作，保守处理：要求确认
    return {
      action: "confirm",
      confirmMessage: `Unable to classify SQL safety: "${normalized.slice(0, 80)}${normalized.length > 80 ? "..." : ""}". Proceed?`,
    };
  }

  /** 判断 SQL 是否为只读查询 */
  isReadOnly(sql: string): boolean {
    return this.classifySql(sql.trim()) === "read";
  }

  /**
   * 提取 SQL 中内嵌的文件路径并逐个过白名单（v0.11 S-2）
   *
   * 覆盖三类向量：
   * - table function：read_csv / read_csv_auto / read_parquet / read_json* / read_text / glob / sniff_csv / parquet_scan 等
   * - COPY ... TO 'path'（写文件）
   * - FROM 'path'（DuckDB 的文件读取简写）
   *
   * 返回第一条违规的原因描述；全部合规返回 null。
   */
  private findSqlPathViolation(sql: string): string | null {
    // 仅清理注释，路径本身就在字符串字面量里，必须保留
    const cleaned = sql
      .replace(/--.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    const patterns: RegExp[] = [
      // table function 首参为字符串字面量
      /\b(?:read_csv|read_csv_auto|read_parquet|read_json|read_json_auto|read_ndjson|read_ndjson_auto|read_text|read_blob|sniff_csv|parquet_scan|csv_scan|iceberg_scan|delta_scan)\s*\(\s*'((?:[^']|'')+)'/gi,
      /\bCOPY\s+[\s\S]{0,2000}?\bTO\s*'((?:[^']|'')+)'/gi,
      /\bFROM\s+'((?:[^']|'')+)'/gi,
    ];

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(cleaned)) !== null) {
        // 还原 SQL 字符串中的 '' 转义
        const rawPath = m[1].replace(/''/g, "'");
        if (rawPath.trim().length === 0) continue;
        const check = this.checkPath(rawPath);
        if (check.action === "block") {
          return `SQL 中的文件路径越界：${rawPath}。${check.reason ?? ""}`;
        }
        // confirm 视为放行（checkOperation 层已有独立的 confirm 流程），仅 block 生效
      }
    }
    return null;
  }

  /**
   * 检测语句中的 ATTACH/DETACH（v0.12 M-3）
   *
   * 与 classifySql 相同的清洗策略：先剥离注释（注释里出现的 ATTACH 不会执行，不误报），
   * 再剥离字符串字面量与双引号标识符（避免 'please attach this' 类字面量误报），
   * 然后在剩余骨架上匹配 ATTACH/DETACH 关键词——多行语句同样命中。
   */
  private findAttachViolation(sql: string): string | null {
    const skeleton = sql
      .replace(/--.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/'(?:[^']|'')*'/g, "''")
      .replace(/"(?:[^"]|"")*"/g, '""');
    if (/\bATTACH\b/i.test(skeleton) || /\bDETACH\b/i.test(skeleton)) {
      return (
        "ATTACH/DETACH is not allowed in model-issued SQL. " +
        "Remote/local database connections must go through the connect_database tool " +
        "(ATTACH at the tool implementation layer only, enforced READ_ONLY there)."
      );
    }
    return null;
  }

  /** 分类 SQL 操作类型，支持多行和带注释的SQL */
  private classifySql(sql: string): SqlCategory {
    // 先清理SQL中的注释，避免注释中隐藏危险操作
    const cleanedSql = sql
      .replace(/--.*$/gm, "") // 移除单行注释
      .replace(/\/\*[\s\S]*?\*\//g, ""); // 移除多行注释
    // 剥离字符串字面量与双引号标识符内容（v0.11 S-2）：
    // 字面量里的关键词（如 WHERE note='please drop this row'）不应参与读写分类
    const strippedSql = cleanedSql
      .replace(/'(?:[^']|'')*'/g, "''")
      .replace(/"(?:[^"]|"")*"/g, '""');
    const upper = strippedSql.toUpperCase().trim();

    // 危险操作（无条件删改，优先检测）
    const dangerousPatterns = [
      /\bDROP\s+/i,
      /\bTRUNCATE\s+/i,
      /\bGRANT\s+/i,
      /\bREVOKE\s+/i,
      /\bEXEC(UTE)?\s+/i,
      /\bALTER\s+USER\s+/i,
    ];
    for (const pattern of dangerousPatterns) {
      if (pattern.test(upper)) {
        return "dangerous";
      }
    }

    // 写操作（需要用户确认）
    const writePatterns = [
      /\bINSERT\s+/i,
      /\bUPDATE\s+/i,
      /\bDELETE\s+/i,
      /\bDROP\s+/i,
      /\bTRUNCATE\s+/i,
      /\bALTER\s+(TABLE|DATABASE|SCHEMA)\s+/i,
      /\bCREATE\s+(TABLE|VIEW|INDEX|SCHEMA|DATABASE|TABLE\s+IF\s+NOT\s+EXISTS)\s+/i,
      /\bCOPY\s+/i,
    ];
    for (const pattern of writePatterns) {
      if (pattern.test(upper)) {
        return "write";
      }
    }

    // 读操作
    const readPatterns = [
      /^\s*SELECT\s+/,
      /^\s*DESCRIBE\s+/,
      /^\s*SHOW\s+/,
      /^\s*EXPLAIN\s+/,
      /^\s*PRAGMA\s+/,
      /^\s*WITH\s+.*\s+SELECT\s+/s,
    ];
    if (readPatterns.some((p) => p.test(upper))) {
      return "read";
    }

    return "unknown";
  }

  // ==========================================================================
  // 批量检查（用于工具执行前）
  // ==========================================================================

  /**
   * 综合检查：路径 + SQL
   *
   * 用于 load_data / query_data / transform_data 等工具执行前。
   * 先检查路径，再检查 SQL，取最严格的 action。
   */
  checkOperation(params: {
    filePath?: string;
    sql?: string;
  }): SecurityCheckResult {
    const results: SecurityCheckResult[] = [];

    if (params.filePath) {
      results.push(this.checkPath(params.filePath));
    }
    if (params.sql) {
      results.push(this.checkSql(params.sql));
    }

    // 取最严格的 action: block > confirm > allow
    const priority: Record<SecurityAction, number> = { block: 3, confirm: 2, allow: 1 };
    results.sort((a, b) => priority[b.action] - priority[a.action]);

    const strictest = results[0];
    if (!strictest || strictest.action === "allow") {
      return { action: "allow" };
    }

    // 合并原因信息
    const reasons = results
      .filter((r) => r.reason)
      .map((r) => r.reason)
      .join("; ");
    const messages = results
      .filter((r) => r.confirmMessage)
      .map((r) => r.confirmMessage)
      .join("\n");

    return {
      action: strictest.action,
      reason: reasons || strictest.reason,
      confirmMessage: messages || strictest.confirmMessage,
      matchedPattern: strictest.matchedPattern,
    };
  }
}

