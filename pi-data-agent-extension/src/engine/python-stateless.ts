/**
 * Pi Data Agent — Python 无状态调用引擎
 *
 * 职责：
 * 1. 检测 Python 环境可用性
 * 2. 生成临时 JSON 配置 → 调用 generate_chart.py → 解析 JSON 输出
 * 3. 失败时返回结构化错误（不抛异常，由调用方决定 fallback）
 *
 * 设计原则：
 * - 每个调用独立（无状态）
 * - 输入输出都通过文件（避免 stdin/stdout 编码问题）
 * - 超时控制（默认 30 秒）
 */

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "../utils/logger.js";

/** 图表配置 */
export interface ChartConfig {
  chartType: "bar" | "line" | "scatter" | "histogram" | "pie" | "box" | "heatmap";
  dataPath: string;
  outputPath: string;
  xColumn?: string;
  yColumn?: string;
  columns?: string[];
  title?: string;
  xLabel?: string;
  yLabel?: string;
  options?: Record<string, unknown>;
}

/** 图表生成结果 */
export interface ChartResult {
  success: boolean;
  outputPath?: string;
  chartType?: string;
  rowCount?: number;
  columns?: string[];
  fileSizeBytes?: number;
  error?: string;
}

/** Python 引擎配置 */
export interface PythonEngineConfig {
  /** Python 可执行文件路径（默认 python3） */
  pythonPath?: string;
  /** generate_chart.py 脚本路径 */
  scriptPath: string;
  /** 单次调用超时（毫秒） */
  timeoutMs?: number;
}

const logger = createLogger("python-engine");

/** Python 无状态调用引擎 */
export class PythonStatelessEngine {
  private config: Required<PythonEngineConfig>;
  private _available: boolean | null = null;

  constructor(config: PythonEngineConfig) {
    this.config = {
      pythonPath: config.pythonPath ?? "python3",
      scriptPath: config.scriptPath,
      timeoutMs: config.timeoutMs ?? 30000,
    };
  }

  // ==========================================================================
  // 环境检测
  // ==========================================================================

  /** 检测 Python + matplotlib + pandas 是否可用 */
  async checkAvailability(): Promise<boolean> {
    if (this._available !== null) return this._available;

    if (!existsSync(this.config.scriptPath)) {
      logger.debug(`Script not found: ${this.config.scriptPath}`);
      this._available = false;
      return false;
    }

    try {
      const result = await this.runCommand([
        "-c",
        "import matplotlib, pandas, seaborn; print('OK')",
      ]);
      this._available = result.stdout.trim() === "OK" && result.exitCode === 0;
    } catch {
      this._available = false;
    }

    if (!this._available) {
      logger.debug(`Python environment not available (checked: ${this.config.pythonPath})`);
    }
    return this._available;
  }

  // ==========================================================================
  // 图表生成
  // ==========================================================================

  /**
   * 生成图表
   *
   * 流程：
   * 1. 检查 Python 环境
   * 2. 将 ChartConfig 写入临时 JSON
   * 3. 调用 generate_chart.py
   * 4. 解析 stdout JSON 输出
   * 5. 清理临时文件
   */
  async generateChart(config: ChartConfig): Promise<ChartResult> {
    const available = await this.checkAvailability();
    if (!available) {
      return {
        success: false,
        error: "Python charting environment not available. Please ensure python3, matplotlib, pandas, and seaborn are installed.",
      };
    }

    // 写入临时配置
    const configPath = join(tmpdir(), `pi_chart_config_${Date.now()}.json`);
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    try {
      const result = await this.runCommand([this.config.scriptPath, configPath]);

      // 清理临时配置
      try { unlinkSync(configPath); } catch { /* ignore */ }

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: `Python process exited with code ${result.exitCode}: ${result.stderr || result.stdout}`,
        };
      }

      // 解析 stdout JSON
      const output = this.parseJsonOutput(result.stdout);
      return output;
    } catch (err) {
      try { unlinkSync(configPath); } catch { /* ignore */ }
      return {
        success: false,
        error: `Failed to generate chart: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  /** 运行 Python 命令 */
  private runCommand(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.pythonPath, args, {
        timeout: this.config.timeoutMs,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });

      child.on("error", (err) => reject(err));

      child.on("close", (code) => {
        resolve({ exitCode: code ?? -1, stdout, stderr });
      });
    });
  }

  /** 从 stdout 解析 JSON 输出（可能包含前后非 JSON 文本） */
  private parseJsonOutput(stdout: string): ChartResult {
    // 尝试直接解析整个 stdout
    try {
      return JSON.parse(stdout.trim()) as ChartResult;
    } catch {
      // 尝试提取最后一个 JSON 对象（找最后一个 { ... }）
      const match = stdout.match(/\{[\s\S]*\}/g);
      if (match && match.length > 0) {
        try {
          return JSON.parse(match[match.length - 1]) as ChartResult;
        } catch {
          // fallthrough
        }
      }
    }

    return {
      success: false,
      error: `Unable to parse Python output: ${stdout.slice(0, 200)}`,
    };
  }
}
