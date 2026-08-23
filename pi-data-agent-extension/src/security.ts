/**
 * Pi Data Agent — P0 安全层
 *
 * 职责：
 * 1. 路径白名单 — 阻止访问允许路径之外的文件
 * 2. SQL 黑名单 — 拦截无条件的危险写操作（DROP/DELETE/TRUNCATE/UPDATE 无 WHERE）
 * 3. 读写确认门控 — 写操作（INSERT/CREATE/UPDATE/DELETE/DROP）需用户确认
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
  // SQL 检查
  // ==========================================================================

  /**
   * 检查 SQL 语句的安全性
   *
   * 三层检查：
   * 1. 黑名单正则 — 无条件的危险操作直接拦截
   * 2. 操作分类 — 区分读/写/危险
   * 3. 写操作确认 — 非只读操作需用户确认（除非 autoConfirmWrite）
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

    // 2. 操作分类
    const category = this.classifySql(normalized);

    // 3. 读操作直接放行
    if (category === "read") {
      return { action: "allow" };
    }

    // 4. 危险/写操作需确认
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

  /** 分类 SQL 操作类型，支持多行和带注释的SQL */
  private classifySql(sql: string): SqlCategory {
    // 先清理SQL中的注释，避免注释中隐藏危险操作
    const cleanedSql = sql
      .replace(/--.*$/gm, "") // 移除单行注释
      .replace(/\/\*[\s\S]*?\*\//g, ""); // 移除多行注释
    const upper = cleanedSql.toUpperCase().trim();

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

/** 创建默认安全层（基于当前 cwd） */
export function createDefaultSecurityChecker(cwd?: string): SecurityChecker {
  const resolvedCwd = resolve(cwd ?? process.cwd());
  const config: SecurityConfig = {
    cwd: resolvedCwd,
    allowedPaths: [resolvedCwd],
    autoConfirmWrite: false,
    dangerousSqlPatterns: [
      /^\s*DROP\s+TABLE\s+\w+\s*;?\s*$/i,
      /^\s*DELETE\s+FROM\s+\w+\s*;?\s*$/i,
      /^\s*UPDATE\s+\w+\s+SET\s+.+\s*;?\s*$/i,
      /^\s*TRUNCATE\s+TABLE\s+\w+\s*;?\s*$/i,
    ],
    blockOutOfBoundsPath: true,
  };
  return new SecurityChecker(config);
}
