/**
 * v0.9 A-3 — 环境自检 + 欢迎引导
 *
 * session_start 时异步执行一次（不阻塞启动），汇总为一段 ≤4 行的就绪信息：
 *
 *   [pi-data-agent] 就绪 ✓ DuckDB(3 张表) ✓ LLM ✓ Python 绘图 ✗
 *     绘图不可用：pip install -r requirements.txt 后 visualize 即可使用
 *   试试：「加载 data.csv 看看有什么」·「按渠道统计销售额并画图」·「导出查询结果」
 *   命令：/dashboard 打开控制台 · /report executive|detailed 生成正式报告
 *
 * 自检项：
 * - DuckDB：引擎初始化成败 + 当前表数
 * - LLM：resolveLLMConfig 是否解析到可用配置
 * - Python 绘图：PythonStatelessEngine.checkAvailability()（结果缓存在 runtime）
 */

import type { DuckDBEngine } from "../engine/duckdb.js";

/** Python 修复提示（与 scripts/check_python_env.py 的 install_suggestion 一致） */
export const PYTHON_INSTALL_HINT = "pip install -r requirements.txt";

/** 环境自检结果 */
export interface EnvCheckResult {
  /** DuckDB 引擎是否初始化成功 */
  duckdbOk: boolean;
  /** 当前库中的表数量（DuckDB 可用时） */
  tableCount: number;
  /** LLM 配置是否可用（影响 AI 字典推断、正式报告起草） */
  llmConfigured: boolean;
  /** Python 绘图环境是否可用（仅影响 visualize 的 PNG 输出） */
  pythonAvailable: boolean;
}

/** 模块级缓存（session_start 写入，visualize 等处读取；对应 runtime 缓存） */
let cachedResult: EnvCheckResult | null = null;

/** 读取缓存的自检结果（未运行过时返回 null） */
export function getCachedEnvCheck(): EnvCheckResult | null {
  return cachedResult;
}

/** 写入缓存的自检结果 */
export function setCachedEnvCheck(result: EnvCheckResult): void {
  cachedResult = result;
}

/**
 * 执行环境自检。
 *
 * 所有子项独立容错：单项失败不影响其他项（失败记为不可用）。
 * 注意：Python 探测会 spawn 子进程（秒级），调用方应异步执行、不阻塞启动。
 */
export async function runEnvCheck(opts: {
  engine: DuckDBEngine | null;
  llmConfigured: boolean;
  /** checkAvailability 回调（如 PythonStatelessEngine.checkAvailability） */
  checkPython: () => Promise<boolean>;
}): Promise<EnvCheckResult> {
  const result: EnvCheckResult = {
    duckdbOk: false,
    tableCount: 0,
    llmConfigured: opts.llmConfigured,
    pythonAvailable: false,
  };

  // DuckDB：初始化成败 + 表数
  if (opts.engine) {
    try {
      await opts.engine.query("SELECT 1");
      result.duckdbOk = true;
      result.tableCount = (await opts.engine.getTables()).length;
    } catch {
      result.duckdbOk = false;
    }
  }

  // Python 绘图
  try {
    result.pythonAvailable = await opts.checkPython();
  } catch {
    result.pythonAvailable = false;
  }

  setCachedEnvCheck(result);
  return result;
}

/**
 * 将自检结果格式化为欢迎引导信息（≤4 行）。
 *
 * 返回行数组；调用方优先 ctx.ui?.notify(lines.join("\n"), "info")，回退逐行 logger.info。
 */
export function formatWelcomeMessage(result: EnvCheckResult): string[] {
  const lines: string[] = [];

  // 第 1 行：就绪状态
  const duckdbPart = result.duckdbOk
    ? `✓ DuckDB(${result.tableCount} 张表)`
    : "✗ DuckDB";
  const llmPart = result.llmConfigured ? "✓ LLM" : "✗ LLM";
  const pythonPart = result.pythonAvailable ? "✓ Python 绘图" : "✗ Python 绘图";
  lines.push(`[pi-data-agent] 就绪 · ${duckdbPart} ${llmPart} ${pythonPart}`);

  // 第 2 行：修复提示（按影响范围排序：DuckDB 核心故障 > 绘图 > LLM，只显示第一条避免刷屏）
  const fixes: string[] = [];
  if (!result.duckdbOk) {
    fixes.push("DuckDB 连接失败：数据加载与查询不可用，请检查 .pi-data-agent/session.duckdb");
  }
  if (!result.pythonAvailable) {
    fixes.push(`绘图不可用：${PYTHON_INSTALL_HINT} 后 visualize 即可使用`);
  }
  if (!result.llmConfigured) {
    fixes.push("LLM 未配置：AI 字典推断、正式报告起草受限，查询与分析不受影响");
  }
  for (const fix of fixes.slice(0, 1)) {
    lines.push(`  ${fix}`);
  }

  // 示例问句 + 命令提示
  lines.push(`试试：「加载 data.csv 看看有什么」·「按渠道统计销售额并画图」·「导出查询结果」`);
  lines.push(`命令：/dashboard 打开控制台 · /report executive|detailed 生成正式报告`);

  return lines;
}

/**
 * 为 Python 不可用的错误信息附加安装命令提示。
 *
 * 用于 visualize 失败路径：检测到"Python 不可用"时，错误信息直接附带安装命令，
 * 而不是裸报错。其他错误原样返回。
 */
export function withPythonInstallHint(errorMessage: string): string {
  if (/not available|not installed|matplotlib|pandas|seaborn/i.test(errorMessage)) {
    if (!errorMessage.includes(PYTHON_INSTALL_HINT)) {
      return `${errorMessage}\n提示: Python 绘图环境不可用，请先运行 \`${PYTHON_INSTALL_HINT}\`，然后重试。`;
    }
  }
  return errorMessage;
}
