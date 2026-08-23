/**
 * v0.9 A-3/A-4 — 环境自检 + 日志分级验收测试（vitest）
 *
 * 覆盖:
 * - E1: logger.debug 受开关控制（默认静默，开启后输出且带统一前缀）
 * - E2: logger.info/warn/error 始终输出
 * - E3: runEnvCheck 各子项独立容错（DuckDB 失败不影响 Python/LLM 结果）
 * - E4: 自检结果写入模块缓存（getCachedEnvCheck）
 * - E5: formatWelcomeMessage——就绪信息 ≤4 行、按缺失项给修复提示、附示例问句与命令
 * - E6: withPythonInstallHint——Python 不可用的错误附带安装命令，不重复追加，无关错误原样返回
 *
 * 测试约束：不依赖真实 python3 与 DuckDB 实例（engine 用桩对象）。
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import {
  PYTHON_INSTALL_HINT,
  runEnvCheck,
  formatWelcomeMessage,
  withPythonInstallHint,
  getCachedEnvCheck,
  setCachedEnvCheck,
  type EnvCheckResult,
} from "../utils/env-check.js";
import { createLogger, setLoggerDebug, isLoggerDebug } from "../utils/logger.js";
import type { DuckDBEngine } from "../engine/duckdb.js";

afterEach(() => {
  vi.restoreAllMocks();
  setLoggerDebug(false);
});

describe("logger 日志分级（A-4）", () => {
  it("E1: debug 默认静默，开启后输出到 stderr 且带统一前缀", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger("test");

    setLoggerDebug(false);
    expect(isLoggerDebug()).toBe(false);
    logger.debug("hidden detail");
    expect(errSpy).not.toHaveBeenCalled();

    setLoggerDebug(true);
    expect(isLoggerDebug()).toBe(true);
    logger.debug("visible detail");
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = String(errSpy.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("[pi-data-agent][test]");
    expect(line).toContain("visible detail");
  });

  it("E2: info/warn/error 不受开关控制", () => {
    setLoggerDebug(false);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger("always");

    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain("[pi-data-agent][always]");
  });
});

describe("runEnvCheck 环境自检（A-3）", () => {
  /** 构造引擎桩：query/getTables 可控成败 */
  function fakeEngine(opts: { ok: boolean; tables?: string[] }): DuckDBEngine {
    return {
      query: async () => {
        if (!opts.ok) throw new Error("cannot connect");
        return { rows: [[1]] };
      },
      getTables: async () => opts.tables ?? [],
    } as never as DuckDBEngine;
  }

  it("E3a: 全部就绪时各项为可用，并记录表数量", async () => {
    const result = await runEnvCheck({
      engine: fakeEngine({ ok: true, tables: ["a", "b", "c"] }),
      llmConfigured: true,
      checkPython: async () => true,
    });
    expect(result.duckdbOk).toBe(true);
    expect(result.tableCount).toBe(3);
    expect(result.llmConfigured).toBe(true);
    expect(result.pythonAvailable).toBe(true);
  });

  it("E3b: 子项失败独立容错——DuckDB 挂掉不影响 Python/LLM 结果", async () => {
    const result = await runEnvCheck({
      engine: fakeEngine({ ok: false }),
      llmConfigured: false,
      checkPython: async () => true,
    });
    expect(result.duckdbOk).toBe(false);
    expect(result.tableCount).toBe(0);
    expect(result.pythonAvailable).toBe(true);
    expect(result.llmConfigured).toBe(false);
  });

  it("E3c: engine 为 null 时 DuckDB 记为不可用；checkPython 抛错记为不可用", async () => {
    const result = await runEnvCheck({
      engine: null,
      llmConfigured: false,
      checkPython: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(result.duckdbOk).toBe(false);
    expect(result.pythonAvailable).toBe(false);
  });

  it("E4: 自检结果写入模块缓存", async () => {
    const before = getCachedEnvCheck();
    const result = await runEnvCheck({
      engine: null,
      llmConfigured: true,
      checkPython: async () => false,
    });
    const cached = getCachedEnvCheck();
    expect(cached).toEqual(result);
    // 缓存内容与最近一次结果一致（无论之前是否有旧值）
    expect(cached?.llmConfigured).toBe(true);
    void before;
  });
});

describe("formatWelcomeMessage 欢迎引导（A-3）", () => {
  const base: EnvCheckResult = {
    duckdbOk: true,
    tableCount: 2,
    llmConfigured: true,
    pythonAvailable: true,
  };

  it("E5a: 全部就绪——无修复提示行，含示例问句与命令提示", () => {
    const lines = formatWelcomeMessage(base);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines[0]).toContain("就绪");
    expect(lines[0]).toContain("✓ DuckDB(2 张表)");
    expect(lines[0]).toContain("✓ LLM");
    expect(lines[0]).toContain("✓ Python 绘图");
    const joined = lines.join("\n");
    expect(joined).toContain("/dashboard");
    expect(joined).toContain("/report");
    expect(joined).not.toContain(PYTHON_INSTALL_HINT);
  });

  it("E5b: Python 缺失——给出影响范围与安装命令", () => {
    const lines = formatWelcomeMessage({ ...base, pythonAvailable: false });
    const joined = lines.join("\n");
    expect(lines[0]).toContain("✗ Python 绘图");
    expect(joined).toContain(`绘图不可用：${PYTHON_INSTALL_HINT}`);
    expect(lines.length).toBeLessThanOrEqual(4);
  });

  it("E5c: 多项缺失时只显示第一条修复提示（避免刷屏）", () => {
    const lines = formatWelcomeMessage({
      duckdbOk: false,
      tableCount: 0,
      llmConfigured: false,
      pythonAvailable: false,
    });
    const joined = lines.join("\n");
    expect(lines[0]).toContain("✗ DuckDB");
    // 三项都缺失，但修复提示只取第一项（DuckDB 优先）
    expect(joined).toContain("DuckDB 连接失败");
    expect(joined).not.toContain("LLM 未配置");
    expect(lines.length).toBeLessThanOrEqual(4);
  });
});

describe("withPythonInstallHint 错误文案增强（A-3）", () => {
  it("E6a: Python 相关错误追加安装命令", () => {
    const out = withPythonInstallHint("Python is not available on this system");
    expect(out).toContain(PYTHON_INSTALL_HINT);
    expect(out).toContain("Python 绘图环境不可用");
  });

  it("E6b: 已包含安装命令时不重复追加", () => {
    const original = `matplotlib missing\n提示: 请先运行 \`${PYTHON_INSTALL_HINT}\``;
    expect(withPythonInstallHint(original)).toBe(original);
  });

  it("E6c: 无关错误原样返回", () => {
    const original = "SQL_ERROR: column \"foo\" does not exist";
    expect(withPythonInstallHint(original)).toBe(original);
  });
});
