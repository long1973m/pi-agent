/**
 * S5.3 Audit Log — 操作审计日志
 *
 * 职责：
 * 1. 记录每个有副作用的工具执行（query_data / load_data / transform_data / export_result / visualize / connect_database）
 * 2. 存储为 JSONL（append-only，便于后续分析）
 * 3. summary 不含敏感连接串、样本、PII
 * 4. 写入失败不影响主流程
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { maskPII } from "./pii-guard.js";
import { redactCredentials } from "./security.js";
import { createLogger } from "./utils/logger.js";

const logger = createLogger("audit-log");

/** 单个日志文件最大大小（10MB），超过后自动轮转 */
const MAX_LOG_SIZE = 10 * 1024 * 1024;
/** 保留的轮转文件数量 */
const MAX_ROTATED_FILES = 5;

/** 审计日志条目 */
export interface AuditLogEntry {
  /** 唯一 ID */
  id: string;
  /** SDK toolCallId */
  toolCallId: string;
  /** 时间戳 ISO */
  timestamp: string;
  /** 工具名称 */
  toolName: string;
  /** 操作描述（脱敏摘要） */
  action: string;
  /** 执行者 */
  actor: "user" | "system";
  /** 耗时毫秒 */
  durationMs: number;
  /** 结果状态 */
  result: "success" | "error" | "blocked";
  /** 脱敏摘要 */
  summary: string;
  /** 用户意图（如有） */
  userIntent?: string;
  /** SQL（如有） */
  sql?: string;
}

/** 需要记录审计日志的工具白名单（有副作用的操作） */
const AUDIT_TOOLS = new Set([
  "query_data",
  "load_data",
  "transform_data",
  "export_result",
  "visualize",
  "connect_database",
]);

/** 审计日志管理器 */
export class AuditLogManager {
  private logPath: string;
  /** 内存中记录每个 toolCallId 的开始时间 */
  private startTimes = new Map<string, number>();
  /** 内存中记录每个 toolCallId 的 args */
  private startArgs = new Map<string, { toolName: string; args: Record<string, unknown> }>();

  constructor(projectDir: string) {
    this.logPath = join(projectDir, "audit.log");
    // 确保目录存在（pi-data-agent 目录在首次写入前可能尚未创建）
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
    } catch {
      // 忽略，append 时会再次报错
    }
    logger.debug(`Initialized, log path: ${this.logPath}`);
  }

  /** 记录工具执行开始 */
  recordStart(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
    if (!AUDIT_TOOLS.has(toolName)) return;
    this.startTimes.set(toolCallId, Date.now());
    this.startArgs.set(toolCallId, { toolName, args });
  }

  /** 记录工具执行完成 */
  recordEnd(params: {
    toolCallId: string;
    result: unknown;
    isError: boolean;
  }): void {
    const startTime = this.startTimes.get(params.toolCallId);
    const startInfo = this.startArgs.get(params.toolCallId);
    this.startTimes.delete(params.toolCallId);
    this.startArgs.delete(params.toolCallId);

    if (!startInfo) return; // 没有 start 信息，不记录
    if (!AUDIT_TOOLS.has(startInfo.toolName)) return; // 不在白名单中，不记录

    const durationMs = startTime ? Date.now() - startTime : 0;
    const entry = this.buildEntry(
      params.toolCallId,
      { toolName: startInfo.toolName, args: startInfo.args, result: params.result, isError: params.isError },
      durationMs
    );
    this.append(entry);
  }

  /** 获取最近 N 条审计记录（从最新轮转文件倒序读取，避免全量加载） */
  getRecent(count: number = 50): AuditLogEntry[] {
    // 收集所有日志文件，按时间倒序（最新优先）
    const logFiles = this.getLogFilesInOrder();
    const entries: AuditLogEntry[] = [];

    for (const filePath of logFiles) {
      if (entries.length >= count) break;
      try {
        const lines = readFileSync(filePath, "utf-8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => {
            try { return JSON.parse(l) as AuditLogEntry; } catch { return null; }
          })
          .filter((e): e is AuditLogEntry => e !== null);
        entries.unshift(...lines);
      } catch {
        // 读取某个文件失败不影响整体
      }
    }

    return entries.slice(-count);
  }

  /** 获取所有日志文件路径，按时间从新到旧排序 */
  private getLogFilesInOrder(): string[] {
    const files: string[] = [];
    // 当前活跃文件（最新）
    if (existsSync(this.logPath)) {
      files.push(this.logPath);
    }
    // 轮转文件（audit.log.1 最新 → audit.log.5 最旧）
    for (let i = 1; i <= MAX_ROTATED_FILES; i++) {
      const rotatedPath = `${this.logPath}.${i}`;
      if (existsSync(rotatedPath)) {
        files.push(rotatedPath);
      }
    }
    return files;
  }

  /** 检查并执行日志轮转 */
  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.logPath)) return;
      const stats = statSync(this.logPath);
      if (stats.size < MAX_LOG_SIZE) return;

      // 删除最旧的轮转文件（audit.log.MAX）
      const oldestPath = `${this.logPath}.${MAX_ROTATED_FILES}`;
      if (existsSync(oldestPath)) {
        unlinkSync(oldestPath);
      }

      // 依次重命名 audit.log.(N-1) → audit.log.N，从大到小
      for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
        const src = `${this.logPath}.${i}`;
        const dst = `${this.logPath}.${i + 1}`;
        if (existsSync(src)) {
          renameSync(src, dst);
        }
      }

      // 当前文件 → audit.log.1
      renameSync(this.logPath, `${this.logPath}.1`);
      logger.debug(`Rotated log file (was ${Math.round(stats.size / 1024)}KB)`);
    } catch {
      // 轮转失败不影响正常写入
    }
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  private buildEntry(
    toolCallId: string,
    params: { toolName: string; args: Record<string, unknown>; result: unknown; isError: boolean },
    durationMs: number
  ): AuditLogEntry {
    const { toolName, args, result, isError } = params;

    // result 状态判断
    let resultStatus: AuditLogEntry["result"] = "success";
    if (isError) {
      resultStatus = "error";
    } else if ((result as any)?.details?.blocked === true) {
      resultStatus = "blocked";
    }

    // summary 脱敏：不包含样本、连接串、PII
    const summary = this.buildSummary(toolName, args, resultStatus);

    // PII 脱敏：对 SQL 和 userIntent 中的个人信息进行遮蔽
    const rawSql = typeof args.sql === "string" ? args.sql : undefined;
    const rawIntent = typeof args.user_intent === "string" ? args.user_intent : undefined;

    return {
      id: `al_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      toolCallId,
      timestamp: new Date().toISOString(),
      toolName,
      actor: "user",
      durationMs,
      result: resultStatus,
      // v0.12 M-6: 落盘前兜底凭据脱敏（防其他工具未来引入连接串）
      action: redactCredentials(summary),
      summary: redactCredentials(summary),
      userIntent: rawIntent ? redactCredentials(maskPII(rawIntent).masked) : undefined,
      sql: rawSql ? redactCredentials(maskPII(rawSql).masked) : undefined,
    };
  }

  private buildSummary(
    toolName: string,
    args: Record<string, unknown>,
    resultStatus: AuditLogEntry["result"]
  ): string {
    switch (toolName) {
      case "query_data": {
        const sql = typeof args.sql === "string" ? maskPII(args.sql).masked : "";
        const table = typeof args.table_name === "string" ? args.table_name : "";
        return `query_data: ${sql.slice(0, 80)}${sql.length > 80 ? "..." : ""} (table: ${table || "unknown"}) — ${resultStatus}`;
      }
      case "load_data": {
        const path = typeof args.file_path === "string" ? args.file_path : "";
        const table = typeof args.table_name === "string" ? args.table_name : "";
        return `load_data: ${path} → ${table || "auto"} — ${resultStatus}`;
      }
      case "transform_data": {
        const sql = typeof args.sql === "string" ? maskPII(args.sql).masked : "";
        return `transform_data: ${sql.slice(0, 80)}${sql.length > 80 ? "..." : ""} — ${resultStatus}`;
      }
      case "export_result": {
        const path = typeof args.file_path === "string" ? args.file_path : "";
        return `export_result: → ${path} — ${resultStatus}`;
      }
      case "visualize": {
        const chartType = typeof args.chart_type === "string" ? args.chart_type : "";
        return `visualize: ${chartType} chart — ${resultStatus}`;
      }
      case "connect_database": {
        const dbType = typeof args.db_type === "string" ? args.db_type : "";
        const path = typeof args.file_path === "string" ? args.file_path : "";
        return `connect_database: ${dbType} — ${path} — ${resultStatus}`;
      }
      default:
        return `${toolName}: executed — ${resultStatus}`;
    }
  }

  private append(entry: AuditLogEntry): void {
    try {
      // 写入前检查是否需要轮转
      this.rotateIfNeeded();
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(this.logPath, line, "utf-8");
      logger.debug(`Recorded: ${entry.toolName} → ${entry.result}`);
    } catch (err) {
      logger.warn("Failed to append:", err);
    }
  }
}
