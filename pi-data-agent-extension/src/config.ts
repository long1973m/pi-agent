/**
 * Pi Data Agent — 配置管理
 *
 * 来源优先级：调用方覆盖 > 环境变量 > 项目级配置文件 > 默认值
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { SecurityConfig } from "./types.js";

/** 应用配置 */
export interface AppConfig {
  /** 当前工作目录 */
  cwd: string;
  /** 允许访问的路径白名单 */
  allowedPaths: string[];
  /** 是否自动确认写操作（危险！仅用于自动化测试） */
  autoConfirmWrite: boolean;
  /** 查询记忆最大保留条数 */
  maxQueryMemoryEntries: number;
  /** 大结果预览行数限制 */
  previewLimit: number;
  /** 数据字典样本行数 */
  dictionarySampleRows: number;
  /** DuckDB 数据库文件路径 */
  dbPath: string;
  /** 全局配置目录 */
  globalConfigDir: string;
  /** 项目配置目录 */
  projectConfigDir: string;
  /** 查询结果落盘目录 */
  outputDir: string;
  /** 文件上传缓存目录 */
  uploadsDir: string;
  /** 可视化最大行数（超过则自动采样） */
  visualizeMaxRows: number;
  /** 采样策略：random（随机采样）| limit（截断） */
  samplingStrategy: "random" | "limit";
  /** 调试日志开关（env PI_DATA_AGENT_DEBUG 或 config.json，默认 false） */
  debug: boolean;
  /** v0.12 M-1: 允许 ATTACH 的远程数据库目标白名单；支持 host 与 host:port 两种格式；空 = 拒绝一切远程连接（fail-closed） */
  dbAllowedHosts: string[];
  /** v0.12 M-1: 远程查询超时（毫秒），传给 mysql_query_timeout_max_ms；夹紧 5_000 ~ 600_000 */
  dbQueryTimeoutMs: number;
}

/** 每次加载都按最终 cwd 创建默认配置，避免路径和数组跨实例共享。 */
function createDefaults(cwd: string): AppConfig {
  return {
    cwd,
    allowedPaths: [cwd],
    autoConfirmWrite: false,
    maxQueryMemoryEntries: 5,
    previewLimit: 100,
    dictionarySampleRows: 5,
    dbPath: join(cwd, ".pi-data-agent", "session.duckdb"),
    globalConfigDir: join(homedir(), ".config", "pi-data-agent"),
    projectConfigDir: join(cwd, ".pi-data-agent"),
    outputDir: join(cwd, ".pi-data-agent", "output"),
    uploadsDir: join(cwd, ".pi-data-agent", "uploads"),
    visualizeMaxRows: 5000,
    samplingStrategy: "random",
    debug: false,
    dbAllowedHosts: [],
    dbQueryTimeoutMs: 300000,
  };
}

/** 环境变量映射 */
const ENV_MAP: Record<string, keyof AppConfig> = {
  PI_DATA_AGENT_CWD: "cwd",
  PI_DATA_AGENT_ALLOWED_PATHS: "allowedPaths",
  PI_DATA_AGENT_AUTO_CONFIRM_WRITE: "autoConfirmWrite",
  PI_DATA_AGENT_MAX_QUERY_MEMORY: "maxQueryMemoryEntries",
  PI_DATA_AGENT_PREVIEW_LIMIT: "previewLimit",
  PI_DATA_AGENT_DB_PATH: "dbPath",
  PI_DATA_AGENT_VISUALIZE_MAX_ROWS: "visualizeMaxRows",
  PI_DATA_AGENT_SAMPLING_STRATEGY: "samplingStrategy",
  PI_DATA_AGENT_DEBUG: "debug",
  PI_DATA_AGENT_DB_ALLOWED_HOSTS: "dbAllowedHosts",
  PI_DATA_AGENT_DB_QUERY_TIMEOUT_MS: "dbQueryTimeoutMs",
};

/** 从环境变量读取配置 */
function readFromEnv(): Partial<AppConfig> {
  const result: Partial<AppConfig> = {};

  for (const [envKey, configKey] of Object.entries(ENV_MAP)) {
    const value = process.env[envKey];
    if (value === undefined) continue;

    switch (configKey) {
      case "allowedPaths":
        result.allowedPaths = value.split(";").map((p) => resolve(p.trim()));
        break;
      case "autoConfirmWrite":
        result.autoConfirmWrite = value.toLowerCase() === "true";
        break;
      case "debug":
        // 支持 PI_DATA_AGENT_DEBUG=1 或 true
        result.debug = value === "1" || value.toLowerCase() === "true";
        break;
      case "maxQueryMemoryEntries":
      case "previewLimit":
      case "visualizeMaxRows":
        result[configKey] = parseInt(value, 10);
        break;
      case "samplingStrategy":
        result[configKey] = value === "limit" ? "limit" : "random";
        break;
      case "dbAllowedHosts":
        // 分号分隔，与 PI_DATA_AGENT_ALLOWED_PATHS 风格一致；空字符串/纯空白 → 空数组（拒绝一切远程）
        result.dbAllowedHosts = value
          .split(";")
          .map((h) => h.trim())
          .filter((h) => h.length > 0);
        break;
      case "dbQueryTimeoutMs":
        result.dbQueryTimeoutMs = parseInt(value, 10);
        break;
      default:
        // @ts-expect-error — string fields
        result[configKey] = value;
        break;
    }
  }

  return result;
}

/** 从项目级配置文件读取 */
function readFromProjectConfig(cwd: string): Partial<AppConfig> {
  const configPath = join(cwd, ".pi-data-agent", "config.json");
  if (!existsSync(configPath)) return {};

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    // 解析路径为绝对路径
    if (parsed.allowedPaths) {
      parsed.allowedPaths = parsed.allowedPaths.map((p) =>
        typeof p === "string" ? resolve(cwd, p) : p
      );
    }
    if (parsed.dbPath) parsed.dbPath = resolve(cwd, parsed.dbPath);
    if (parsed.outputDir) parsed.outputDir = resolve(cwd, parsed.outputDir);
    return parsed;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[Config] Failed to load project config from ${configPath}: ${errMsg}`);
    console.warn(`[Config] Please fix the config.json format and restart the app. Using default configuration.`);
    // 可选：给用户直接展示错误，方便排查
    if (process.env.NODE_ENV !== "production") {
      console.error(`Config Error Detail: ${errMsg}`);
    }
    return {};
  }
}

/** 加载配置（优先级：调用方覆盖 > 环境变量 > 项目配置 > 默认值） */
export function loadConfig(overrides?: Partial<AppConfig>): AppConfig {
  const envConfig = readFromEnv();

  // 只加载初始 cwd 的项目配置，再按最终优先级计算默认路径，不递归加载。
  const initialCwd = resolve(overrides?.cwd ?? envConfig.cwd ?? process.cwd());
  const projectConfig = readFromProjectConfig(initialCwd);
  const effectiveCwd = resolve(
    overrides?.cwd ?? envConfig.cwd ?? projectConfig.cwd ?? initialCwd
  );

  const merged: AppConfig = {
    ...createDefaults(effectiveCwd),
    ...projectConfig,
    ...envConfig,
    ...overrides,
  };

  // allowedPaths 下方的 map 已创建副本；主机白名单也不能与调用方共享引用。
  merged.dbAllowedHosts = [...merged.dbAllowedHosts];

  // 确保路径是绝对路径
  merged.cwd = resolve(merged.cwd);
  merged.allowedPaths = merged.allowedPaths.map((p) => resolve(p));
  merged.dbPath = resolve(merged.cwd, merged.dbPath);
  merged.globalConfigDir = resolve(homedir(), merged.globalConfigDir);
  merged.projectConfigDir = resolve(merged.cwd, merged.projectConfigDir);
  merged.outputDir = resolve(merged.cwd, merged.outputDir);
  merged.uploadsDir = resolve(merged.cwd, merged.uploadsDir);

  // v0.12 M-1: 远程查询超时夹紧（5 秒 ~ 10 分钟）
  if (!Number.isFinite(merged.dbQueryTimeoutMs)) merged.dbQueryTimeoutMs = 300000;
  merged.dbQueryTimeoutMs = Math.min(600_000, Math.max(5_000, Math.round(merged.dbQueryTimeoutMs)));

  // 确保 uploads 目录始终在白名单中（上传功能的必要条件）
  if (!merged.allowedPaths.some((p) => p === merged.uploadsDir)) {
    merged.allowedPaths.push(merged.uploadsDir);
  }

  return merged;
}

/** 确保上传目录存在，不存在则创建 */
export function ensureUploadsDir(config: AppConfig): void {
  if (!existsSync(config.uploadsDir)) {
    mkdirSync(config.uploadsDir, { recursive: true });
  }
}

/** 写令牌请求头名称（R-1 收敛：单一出处，dashboard 侧经 dashboard/config.ts 转出） */
export const WRITE_TOKEN_HEADER = "X-Write-Token";

/** 从 AppConfig 生成 SecurityConfig */
export function toSecurityConfig(config: AppConfig): SecurityConfig {
  return {
    cwd: config.cwd,
    allowedPaths: config.allowedPaths,
    autoConfirmWrite: config.autoConfirmWrite,
    dangerousSqlPatterns: [
      // DROP TABLE 无 WHERE（DuckDB 不支持 WHERE 在 DROP，但保留模式用于其他 DB）
      /^\s*DROP\s+TABLE\s+\w+\s*;?\s*$/i,
      // DELETE 无 WHERE
      /^\s*DELETE\s+FROM\s+\w+\s*;?\s*$/i,
      // UPDATE 无 WHERE
      /^\s*UPDATE\s+\w+\s+SET\s+.+\s*;?\s*$/i,
      // TRUNCATE
      /^\s*TRUNCATE\s+TABLE\s+\w+\s*;?\s*$/i,
    ],
    blockOutOfBoundsPath: true,
    dbAllowedHosts: config.dbAllowedHosts,
    dbQueryTimeoutMs: config.dbQueryTimeoutMs,
  };
}
