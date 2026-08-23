/**
 * Pi Data Agent — 日志分级工具（v0.9 A-4）
 *
 * - debug()：仅在 PI_DATA_AGENT_DEBUG=1（或 true）或 config.debug=true 时输出到 stderr
 * - info()/warn()/error()：始终输出
 * - 统一前缀 [pi-data-agent]，便于在 TUI 中识别与过滤
 *
 * 用法：
 *   const logger = createLogger("index");
 *   logger.debug("progress detail");   // 默认静默
 *   logger.error("real failure");      // 始终可见
 */

/** 日志级别 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** 统一前缀 */
const PREFIX = "[pi-data-agent]";

/** debug 是否开启（模块级状态，env 初始化 + config 热更新） */
let debugEnabled = readDebugFromEnv();

/** 从环境变量读取 debug 开关（PI_DATA_AGENT_DEBUG=1 或 true） */
function readDebugFromEnv(): boolean {
  const value = process.env.PI_DATA_AGENT_DEBUG;
  if (value === undefined) return false;
  return value === "1" || value.toLowerCase() === "true";
}

/**
 * 设置 debug 开关（session_start 加载 config 后调用，合并 env 与 config.debug）
 */
export function setLoggerDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

/** 当前 debug 开关状态（测试用） */
export function isLoggerDebug(): boolean {
  return debugEnabled;
}

/**
 * 创建带 scope 的 logger
 *
 * 输出格式：`[pi-data-agent][<scope>] <message> <args...>`
 * - debug → stderr（console.error，受开关控制）
 * - info → stdout（console.log）
 * - warn → stderr（console.warn）
 * - error → stderr（console.error）
 */
export function createLogger(scope: string): Logger {
  const tag = `${PREFIX}[${scope}]`;
  const format = (message: string, args: unknown[]): string =>
    [tag, message, ...args.map((a) => (a instanceof Error ? a.message : String(a)))].join(" ");

  return {
    debug: (message, ...args) => {
      if (!debugEnabled) return;
      console.error(format(message, args));
    },
    info: (message, ...args) => {
      console.log(format(message, args));
    },
    warn: (message, ...args) => {
      console.warn(format(message, args));
    },
    error: (message, ...args) => {
      console.error(format(message, args));
    },
  };
}
