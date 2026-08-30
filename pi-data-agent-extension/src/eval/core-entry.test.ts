/**
 * T-3 — index.ts 入口装配测试（vitest）
 *
 * 覆盖:
 * - E1: factory 注册 14 个工具 + 2 个命令 + 生命周期/审计 hooks
 * - E2: session_start 在隔离 cwd 完成运行时初始化（不抛错、.pi-data-agent 建好）
 * - E3: before_agent_start 返回注入了数据助手规则与基础 prompt 的 systemPrompt
 * - E4: session_shutdown 保存状态并清理，二次调用幂等安全
 *
 * 测试约束：stub ExtensionAPI/ExtensionContext，隔离临时目录做 cwd，不触碰共享状态。
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import factory from "../index.js";

/** 期望注册的工具名（与 index.ts 尾部 logger.debug 清单一致） */
const EXPECTED_TOOLS = [
  "load_data",
  "describe_data",
  "query_data",
  "transform_data",
  "list_datasets",
  "ask_clarification",
  "export_result",
  "visualize",
  "show_image",
  "connect_database",
  "confirm_dictionary",
  "generate_report",
  "generate_session_report",
  "get_table_card",
];

/** stub ExtensionAPI：捕获事件处理器 / 工具 / 命令注册 */
function makeStubPi() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools: Array<{ name: string }> = [];
  const commands = new Map<string, { description: string }>();

  const pi = {
    on: (type: string, handler: (...args: unknown[]) => unknown) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(handler);
    },
    registerTool: (tool: { name: string }) => {
      tools.push(tool);
    },
    registerCommand: (name: string, cmd: { description: string }) => {
      commands.set(name, cmd);
    },
  };

  return { pi, handlers, tools, commands };
}

/** stub ExtensionContext：隔离临时目录 + 最小 sessionManager */
function makeStubCtx(cwd: string) {
  return {
    cwd,
    sessionManager: { getBranch: () => [] },
    ui: undefined,
    model: undefined,
  } as never;
}

let tmpRoot: string | null = null;

function freshTmp(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), "pi-entry-test-"));
  return tmpRoot;
}

afterEach(() => {
  if (tmpRoot && existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

describe("index.ts 入口装配（T-3）", () => {
  it("E1: 注册 14 个工具、2 个命令、生命周期与审计 hooks", async () => {
    const { pi, handlers, tools, commands } = makeStubPi();
    await (factory as (pi: unknown) => Promise<void>)(pi);

    // 工具清单完全匹配
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());

    // 命令
    expect(commands.has("dashboard")).toBe(true);
    expect(commands.has("report")).toBe(true);

    // hooks
    for (const type of [
      "session_start",
      "session_shutdown",
      "before_agent_start",
      "tool_call",
      "tool_execution_start",
      "tool_execution_end",
    ]) {
      expect(handlers.get(type)?.length, `应注册 ${type} hook`).toBeGreaterThan(0);
    }
  });

  it("E2: session_start 完成运行时初始化（DuckDB 引擎按配置初始化）", async () => {
    const { pi, handlers } = makeStubPi();
    await (factory as (pi: unknown) => Promise<void>)(pi);

    // 注：config.ts 的 DEFAULTS 把 projectConfigDir/dbPath 算成模块加载时的绝对路径，
    // cwd 覆盖无法隔离这些目录；此处用 env 覆盖 dbPath 到临时文件，
    // 以「DuckDB 文件被真实创建」作为 session_start 全链路初始化的可观测副作用。
    const dbPath = join(freshTmp(), "session.duckdb");
    process.env.PI_DATA_AGENT_DB_PATH = dbPath;
    try {
      const onSessionStart = handlers.get("session_start")![0];
      await expect(
        onSessionStart({ reason: "startup" }, makeStubCtx(dbPath))
      ).resolves.toBeUndefined();

      // engine.init() 真实执行：DuckDB 文件落盘
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      delete process.env.PI_DATA_AGENT_DB_PATH;
    }
  });

  it("E3: before_agent_start 返回注入数据助手规则的 systemPrompt", async () => {
    const { pi, handlers } = makeStubPi();
    await (factory as (pi: unknown) => Promise<void>)(pi);

    const cwd = freshTmp();
    await handlers.get("session_start")![0]({ reason: "startup" }, makeStubCtx(cwd));

    const result = (await handlers.get("before_agent_start")![0](
      { systemPrompt: "BASE_PROMPT" },
      makeStubCtx(cwd),
    )) as { systemPrompt: string };

    expect(typeof result.systemPrompt).toBe("string");
    // 基础 prompt 保留
    expect(result.systemPrompt).toContain("BASE_PROMPT");
    // 扩展身份与关键规则注入
    expect(result.systemPrompt).toContain("Pi Data Agent Extension");
    expect(result.systemPrompt).toContain("user_intent");
    expect(result.systemPrompt).toContain("get_table_card");
  });

  it("E4: session_shutdown 清理后二次调用幂等安全", async () => {
    const { pi, handlers } = makeStubPi();
    await (factory as (pi: unknown) => Promise<void>)(pi);

    const cwd = freshTmp();
    await handlers.get("session_start")![0]({ reason: "startup" }, makeStubCtx(cwd));

    // 第一次 shutdown：保存状态 + 关闭 DuckDB + 停 Dashboard，不应抛错
    await expect(
      handlers.get("session_shutdown")![0]({ reason: "exit" }, makeStubCtx(cwd))
    ).resolves.toBeUndefined();

    // runtime 已置 null，第二次 shutdown 走 !runtime 早退分支
    await expect(
      handlers.get("session_shutdown")![0]({ reason: "exit" }, makeStubCtx(cwd))
    ).resolves.toBeUndefined();
  });
});
