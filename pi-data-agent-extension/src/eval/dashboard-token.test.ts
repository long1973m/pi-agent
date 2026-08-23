/**
 * v0.10 K-0 — Dashboard 写令牌持久化验收测试（vitest）
 *
 * 覆盖:
 * - T1: 首次启动生成令牌并写入 <projectDir>/dashboard-token（UUID 格式、权限 0600）
 * - T2: 停止后再次启动（模拟 pi 重启 / 重新执行 /dashboard）复用同一令牌
 * - T3: 令牌文件内容非法时重建新令牌并覆盖写回（仍 0600）
 * - T4: 删除令牌文件后重启自动重建
 * - T5: startDashboard 返回的 handle.writeToken 与文件内容一致
 *
 * 测试约束：独立临时目录做 projectDir（mkdtempSync 隔离，不触碰共享 .pi-data-agent）；
 * createServer 用桩替身，不真正绑定端口；afterEach 清理临时目录。
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";

import { startDashboard, loadOrCreateWriteToken } from "../dashboard/lifecycle.js";
import type { DashboardConfig, DashboardHandle } from "../dashboard/types.js";

/** UUID 格式（与 lifecycle.ts 的复用判定一致） */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let tmpRoot: string | null = null;
const handles: DashboardHandle[] = [];

/** createServer 桩：记录每次传入的令牌，返回最小 Server 替身（只需满足 handle.stop() 的 close 约定） */
function stubCreateServer(tokens: string[]) {
  return async (_port: number, writeToken: string): Promise<Server> => {
    tokens.push(writeToken);
    return { close: (cb?: () => void) => cb?.() } as unknown as Server;
  };
}

/** 在隔离临时目录中启动 Dashboard（projectDir 即生产语义下的 .pi-data-agent/） */
async function startInIsolatedDir(tokens: string[] = []): Promise<{ handle: DashboardHandle; projectDir: string; tokenPath: string }> {
  tmpRoot = mkdtempSync(join(tmpdir(), "pi-token-test-"));
  const projectDir = join(tmpRoot, ".pi-data-agent");
  const config: DashboardConfig = { projectDir };
  const handle = await startDashboard(config, stubCreateServer(tokens));
  handles.push(handle);
  return { handle, projectDir, tokenPath: join(projectDir, "dashboard-token") };
}

afterEach(async () => {
  for (const handle of handles) {
    try {
      await handle.stop();
    } catch { /* 桩的 close 不会抛，防御性忽略 */ }
  }
  handles.length = 0;
  if (tmpRoot && existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

describe("Dashboard 写令牌持久化（K-0）", () => {
  it("T1: 首次启动生成令牌并写入文件，权限 0600，格式为 UUID", async () => {
    const { projectDir, tokenPath } = await startInIsolatedDir();

    expect(existsSync(tokenPath)).toBe(true);
    const content = readFileSync(tokenPath, "utf8").trim();
    expect(content).toMatch(UUID_PATTERN);
    // POSIX 权限位（macOS/Linux 稳定）
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

    // projectDir 不存在时也能自动创建（首次启动场景）
    expect(existsSync(projectDir)).toBe(true);
  });

  it("T2: 停止后再次启动复用同一令牌（模拟 pi 重启 / 重新执行 /dashboard）", async () => {
    const tokens: string[] = [];
    const { handle, tokenPath } = await startInIsolatedDir(tokens);
    const firstToken = handle.writeToken;

    // index.ts 的 /dashboard 命令先 stopDashboard 再 startDashboard；进程重启等价于 stop 后再 start
    await handle.stop();
    const config: DashboardConfig = { projectDir: join(tmpRoot!, ".pi-data-agent") };
    const second = await startDashboard(config, stubCreateServer(tokens));
    handles.push(second);

    expect(second.writeToken).toBe(firstToken);
    expect(readFileSync(tokenPath, "utf8").trim()).toBe(firstToken);
  });

  it("T3: 令牌文件内容非法时重建新令牌并覆盖写回（仍 0600）", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pi-token-test-"));
    const projectDir = join(tmpRoot, ".pi-data-agent");
    mkdirSync(projectDir, { recursive: true });
    const tokenPath = join(projectDir, "dashboard-token");
    writeFileSync(tokenPath, "not-a-valid-uuid");

    const config: DashboardConfig = { projectDir };
    const handle = await startDashboard(config, stubCreateServer([]));
    handles.push(handle);

    expect(handle.writeToken).not.toBe("not-a-valid-uuid");
    expect(handle.writeToken).toMatch(UUID_PATTERN);
    // 非法内容被新令牌覆盖，且覆盖写回后权限仍收紧到 0600
    expect(readFileSync(tokenPath, "utf8").trim()).toBe(handle.writeToken);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("T4: 删除令牌文件后重启自动重建", async () => {
    const { handle, tokenPath } = await startInIsolatedDir();
    const oldToken = handle.writeToken;
    await handle.stop();

    rmSync(tokenPath);
    const config: DashboardConfig = { projectDir: join(tmpRoot!, ".pi-data-agent") };
    const rebuilt = await startDashboard(config, stubCreateServer([]));
    handles.push(rebuilt);

    expect(existsSync(tokenPath)).toBe(true);
    expect(rebuilt.writeToken).toMatch(UUID_PATTERN);
    expect(rebuilt.writeToken).not.toBe(oldToken);
  });

  it("T5: handle.writeToken 与文件内容一致", async () => {
    const { handle, tokenPath } = await startInIsolatedDir();

    expect(handle.writeToken).toBe(readFileSync(tokenPath, "utf8").trim());
    expect(handle.writeToken).toMatch(UUID_PATTERN);
  });

  it("T6: loadOrCreateWriteToken 对合法文件直接复用，不重写内容", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pi-token-test-"));
    const projectDir = join(tmpRoot, ".pi-data-agent");
    mkdirSync(projectDir, { recursive: true });
    const tokenPath = join(projectDir, "dashboard-token");
    const existing = "0123abcd-45ef-67ab-89cd-0123456789ef";
    writeFileSync(tokenPath, `${existing}\n`, { mode: 0o600 });

    expect(loadOrCreateWriteToken(projectDir)).toBe(existing);
    expect(readFileSync(tokenPath, "utf8").trim()).toBe(existing);
  });
});
