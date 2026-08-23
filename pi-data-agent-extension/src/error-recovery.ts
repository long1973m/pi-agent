/**
 * S4.1 error-recovery — 错误自修复
 *
 * 接口：executeWithRecovery(executeFn, config, context, onUpdate)
 *
 * 规则：
 * - 最大 3 次重试
 * - 连续 3 次相同错误立即停止
 * - 每次重试通过 onUpdate 通知用户
 * - 最终失败返回完整调试上下文（SQL + 错误 + schema + 样本 + 修复路径）
 * - 未解决的失败不得写入长期记忆
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { DuckDBEngine } from "./engine/duckdb.js";
import type { ColumnInfo } from "./types.js";
import { createLogger } from "./utils/logger.js";

/** 错误恢复配置 */
export interface ErrorRecoveryConfig {
  /** 最大重试次数（默认 3） */
  maxRetries: number;
  /** 连续相同错误阈值（默认 3） */
  sameErrorThreshold: number;
}

/** 恢复上下文 */
export interface RecoveryContext {
  /** 相关 SQL */
  sql?: string;
  /** 相关表名 */
  tableName?: string;
  /** DuckDB 引擎（用于获取 schema 和样本） */
  engine?: DuckDBEngine | null;
  /** 工具名（用于日志） */
  toolName: string;
}

/** 执行结果 */
export interface RecoveryResult<T> {
  /** 成功结果 */
  result?: T;
  /** 最终错误信息 */
  error?: string;
  /** 是否经过重试 */
  retried: boolean;
  /** 重试次数 */
  retryCount: number;
  /** 已尝试的修复路径 */
  attemptedFixes: string[];
  /** 完整调试上下文（失败时） */
  debugContext?: {
    sql?: string;
    errorMessage: string;
    schema?: ColumnInfo[];
    sample?: unknown[][];
    attemptedFixes: string[];
  };
}

const logger = createLogger("error-recovery");

const DEFAULT_CONFIG: ErrorRecoveryConfig = {
  maxRetries: 3,
  sameErrorThreshold: 3,
};

/** 规范化错误消息（用于比较是否相同错误） */
function normalizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // 提取核心错误信息（去掉位置/行号等变化部分）
  return msg
    .replace(/at\s+position\s+\d+/gi, "")
    .replace(/line\s+\d+/gi, "")
    .replace(/column\s+\d+/gi, "")
    .trim()
    .slice(0, 200); // 只比较前 200 字符
}

/** 获取调试上下文 */
async function gatherDebugContext(
  context: RecoveryContext
): Promise<RecoveryResult<never>["debugContext"]> {
  if (!context.engine) return undefined;

  const schema = context.tableName
    ? await context.engine.getSchema(context.tableName).catch(() => undefined)
    : undefined;

  const sample = context.tableName
    ? await context.engine.getSample(context.tableName, 3).catch(() => undefined)
    : undefined;

  return {
    sql: context.sql,
    errorMessage: "",
    schema,
    sample,
    attemptedFixes: [],
  };
}

/**
 * 执行带错误恢复
 *
 * @param executeFn 要执行的函数
 * @param config 恢复配置
 * @param context 恢复上下文
 * @param onUpdate 每次重试时的回调
 */
export async function executeWithRecovery<T>(
  executeFn: () => Promise<T>,
  config: Partial<ErrorRecoveryConfig> = {},
  context: RecoveryContext,
  onUpdate?: (message: string) => void,
  autoFixFn?: (err: Error, context: RecoveryContext) => Promise<() => Promise<T>> | (() => Promise<T>)
): Promise<RecoveryResult<T>> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let retryCount = 0;
  let lastError = "";
  let consecutiveSameError = 1;
  let currentExecuteFn = executeFn;
  const attemptedFixes: string[] = [];

  const notify = (msg: string) => {
    logger.debug(msg);
    onUpdate?.(msg);
  };

  while (retryCount <= cfg.maxRetries) {
    try {
      const result = await currentExecuteFn();
      return {
        result,
        retried: retryCount > 0,
        retryCount,
        attemptedFixes,
      };
    } catch (err) {
      const normalizedError = normalizeError(err);
      const fullError = err instanceof Error ? err.message : String(err);

      // 检测连续相同错误
      if (normalizedError === lastError) {
        consecutiveSameError++;
      } else {
        consecutiveSameError = 1;
        lastError = normalizedError;
      }

      if (consecutiveSameError >= cfg.sameErrorThreshold) {
        notify(
          `Stopped: Same error occurred ${consecutiveSameError} times consecutively.`
        );
        const debugCtx = await gatherDebugContext(context);
        return {
          error: fullError,
          retried: retryCount > 0,
          retryCount,
          attemptedFixes,
          debugContext: debugCtx
            ? {
                ...debugCtx,
                errorMessage: fullError,
                attemptedFixes,
              }
            : undefined,
        };
      }

      if (retryCount < cfg.maxRetries) {
        // 尝试自动修复
        if (autoFixFn && err instanceof Error) {
          try {
            notify(`Attempting auto-fix for error: ${fullError.slice(0, 80)}`);
            const fixedFn = await autoFixFn(err, context);
            currentExecuteFn = fixedFn;
            attemptedFixes.push(`Auto-fixed: ${fullError.slice(0, 100)}`);
            notify("Auto-fix applied, retrying...");
          } catch (fixErr) {
            const fixErrorMsg = fixErr instanceof Error ? fixErr.message : String(fixErr);
            attemptedFixes.push(`Auto-fix failed: ${fixErrorMsg.slice(0, 100)}`);
            notify(`Auto-fix failed: ${fixErrorMsg.slice(0, 80)}, retrying original...`);
          }
        } else {
          const fixAttempt = `Retry ${retryCount + 1}: ${fullError.slice(0, 100)}`;
          attemptedFixes.push(fixAttempt);
          notify(
            `Error (attempt ${retryCount + 1}/${cfg.maxRetries}): ${fullError.slice(0, 100)}... Retrying...`
          );
        }
      } else {
        notify(`All ${cfg.maxRetries} retry attempts failed.`);
        const debugCtx = await gatherDebugContext(context);
        return {
          error: fullError,
          retried: true,
          retryCount,
          attemptedFixes,
          debugContext: debugCtx
            ? {
                ...debugCtx,
                errorMessage: fullError,
                attemptedFixes,
              }
            : undefined,
        };
      }

      retryCount++;
    }
  }

  // 不应该到达这里
  return {
    error: "Unexpected recovery loop exit",
    retried: retryCount > 0,
    retryCount,
    attemptedFixes,
  };
}

/**
 * 将 RecoveryResult 转换为 AgentToolResult
 *
 * 用于工具层直接返回
 */
export function recoveryResultToToolResult(
  recovery: RecoveryResult<AgentToolResult<unknown>> | RecoveryResult<any>,
  toolName: string
): AgentToolResult<unknown> {
  if (recovery.result) {
    // 成功，但如果有重试，在 details 中标记
    if (recovery.retried) {
      const original = recovery.result;
      return {
        ...original,
        details: {
          ...(original.details || {}),
          toolName,
          retried: true,
          retryCount: recovery.retryCount,
          attemptedFixes: recovery.attemptedFixes,
        },
      };
    }
    return recovery.result;
  }

  // 失败
  const debugInfo = recovery.debugContext
    ? `

Debug Context:
${recovery.debugContext.sql ? `- SQL: ${recovery.debugContext.sql}` : ""}
- Error: ${recovery.debugContext.errorMessage}
${recovery.debugContext.schema ? `- Schema: ${recovery.debugContext.schema.map((c) => `${c.name}(${c.type})`).join(", ")}` : ""}
${recovery.debugContext.sample ? `- Sample: ${JSON.stringify(recovery.debugContext.sample.slice(0, 2))}` : ""}
- Attempted fixes: ${recovery.attemptedFixes.join("; ") || "none"}`
    : "";

  return {
    content: [
      {
        type: "text",
        text: `Error after ${recovery.retryCount} retry attempts: ${recovery.error}${debugInfo}`,
      },
    ],
    details: {
      toolName,
      error: recovery.error,
      retried: recovery.retried,
      retryCount: recovery.retryCount,
      attemptedFixes: recovery.attemptedFixes,
      debugContext: recovery.debugContext,
    },
  };
}
