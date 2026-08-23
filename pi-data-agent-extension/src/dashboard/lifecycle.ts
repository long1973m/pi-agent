/**
 * Pi Data Agent Dashboard — 生命周期管理
 *
 * 职责：
 * 1. 端口扫描（3456~3465），端口占用时自动递增
 * 2. 同一项目重复启动时复用已有实例
 * 3. 启动/停止 Express 服务
 * 4. 加载/持久化写令牌（.pi-data-agent/dashboard-token）
 */

import type { DashboardConfig, DashboardHandle } from "./types.js";
import { DEFAULT_PORT, MAX_PORT, BIND_HOST } from "./config.js";

import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("dashboard-lifecycle");

/** 写令牌文件名（位于 projectDir，即 .pi-data-agent/ 下） */
const WRITE_TOKEN_FILE = "dashboard-token";

/** UUID 格式（令牌文件内容必须整体匹配才视为合法可复用） */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 加载或生成写令牌，并持久化到 `<projectDir>/dashboard-token`。
 *
 * 安全边界说明（威胁模型）：
 * 该令牌是本机 CSRF 盾，不是访问凭证——Dashboard 服务只绑定 127.0.0.1，
 * 且 GET /api/config 本来就会把令牌下发给任意本地页面。
 * 因此把它以 0600 权限持久化到项目目录不会弱化安全模型：
 * 能读到这个文件的本机进程，本来也能直接请求 /api/config 拿到令牌。
 *
 * 行为：
 * - 文件存在且内容是合法 UUID → 复用（pi 重启 / 重新执行 /dashboard 后旧标签页不失效）
 * - 文件不存在或内容非法 → 生成新 UUID 并写入（权限 0600）
 */
export function loadOrCreateWriteToken(projectDir: string): string {
  const tokenPath = join(projectDir, WRITE_TOKEN_FILE);

  if (existsSync(tokenPath)) {
    try {
      const raw = readFileSync(tokenPath, "utf8").trim();
      if (UUID_PATTERN.test(raw)) {
        return raw;
      }
      logger.warn(`写令牌文件格式非法，将重新生成: ${tokenPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`读取写令牌文件失败，将重新生成: ${msg}`);
    }
  }

  const token = randomUUID();
  try {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    // 显式 chmod：writeFileSync 的 mode 只在新建文件时生效，
    // 覆盖已存在的非法文件时需显式收紧权限
    chmodSync(tokenPath, 0o600);
  } catch (err) {
    // 持久化失败不阻塞启动：退化为会话级随机令牌（行为与 v0.9 一致），仅告警
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`写令牌持久化失败（本次会话退化为随机令牌）: ${msg}`);
  }
  return token;
}

/** 活跃实例注册表（projectDir → DashboardHandle） */
const activeInstances = new Map<string, DashboardHandle>();

/**
 * 启动 Dashboard 服务
 *
 * - 默认绑定 127.0.0.1:3456
 * - 端口占用时依次尝试 3457~3465
 * - 同一 projectDir 重复启动时复用已有实例
 * - 写令牌从 <projectDir>/dashboard-token 加载，缺失或非法时生成并持久化
 * - 端口全部占用时抛出明确错误
 */
export async function startDashboard(
  config: DashboardConfig,
  createServer: (port: number, writeToken: string) => Promise<Server>
): Promise<DashboardHandle> {
  // 检查是否已有同项目的活跃实例
  const existing = activeInstances.get(config.projectDir);
  if (existing) {
    logger.debug(`Reusing existing instance on port ${existing.port}`);
    return existing;
  }

  const port = config.port ?? DEFAULT_PORT;
  // 写令牌持久化：同一项目重启后复用同一令牌，旧浏览器标签页的写请求不失效
  const writeToken = loadOrCreateWriteToken(config.projectDir);

  // 端口扫描
  let server: Server | null = null;
  let actualPort = port;

  for (let attempt = 0; attempt < MAX_PORT - port + 1; attempt++) {
    actualPort = port + attempt;
    try {
      server = await createServer(actualPort, writeToken);
      logger.debug(`Server started on ${BIND_HOST}:${actualPort}`);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Port ${actualPort} unavailable: ${msg}`);
      server = null;
    }
  }

  if (!server) {
    throw new Error(
      `Dashboard 无法启动：端口 ${port}~${MAX_PORT} 全部被占用。请关闭不需要的服务后重试。`
    );
  }

  const url = `http://${BIND_HOST}:${actualPort}`;

  const handle: DashboardHandle = {
    url,
    port: actualPort,
    writeToken,
    stop: async () => {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      activeInstances.delete(config.projectDir);
      logger.debug(`Server stopped on port ${actualPort}`);
    },
  };

  activeInstances.set(config.projectDir, handle);
  return handle;
}

/**
 * 停止指定项目的 Dashboard 实例
 */
export async function stopDashboard(projectDir: string): Promise<void> {
  const existing = activeInstances.get(projectDir);
  if (existing) {
    await existing.stop();
  }
}

/**
 * 获取指定项目的活跃 Dashboard 实例（如无则返回 null）
 */
export function getActiveDashboard(projectDir: string): DashboardHandle | null {
  return activeInstances.get(projectDir) ?? null;
}

/**
 * 停止所有活跃 Dashboard 实例
 */
export async function stopAllDashboards(): Promise<void> {
  const dirs = [...activeInstances.keys()];
  await Promise.all(dirs.map((dir) => stopDashboard(dir)));
}