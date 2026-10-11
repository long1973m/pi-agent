/**
 * 绘图依赖探测（测试侧）
 *
 * 与产品侧 PythonStatelessEngine.checkAvailability 相同的三项依赖
 * （matplotlib / pandas / seaborn）。缺依赖时测试应明确 skip 并打印安装命令，
 * 而不是抛 ImportError —— 否则真回归会被环境红灯掩盖。
 *
 * 结果在模块级缓存：同一次测试进程只 spawn 一次。
 */

import { spawnSync } from "node:child_process";

/** 与 utils/env-check.ts 的 PYTHON_INSTALL_HINT 保持一致 */
export const PYTHON_INSTALL_HINT = "pip install -r requirements.txt";

let cached: boolean | null = null;

/** 探测 python3 是否具备 matplotlib + pandas + seaborn（同步、有超时、结果缓存） */
export function pythonChartingAvailable(): boolean {
  if (cached !== null) return cached;

  try {
    const result = spawnSync(
      "python3",
      ["-c", "import matplotlib, pandas, seaborn"],
      { encoding: "utf8", timeout: 15_000 },
    );
    cached = result.status === 0;
  } catch {
    cached = false;
  }

  return cached;
}

/** 缺依赖时的 skip 说明（含安装命令） */
export function pythonChartingSkipReason(): string {
  return `Python 绘图依赖缺失，跳过；安装后可完整验证：${PYTHON_INSTALL_HINT}`;
}
