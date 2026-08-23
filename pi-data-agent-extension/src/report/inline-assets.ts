/**
 * Task 3 — 图表 base64 内联
 *
 * 从 transcript 的工具调用信息中提取图表文件路径（visualize / show_image 产出），
 * 读取并转为 base64 data URI，嵌入 HTML。
 *
 * 阈值控制：
 * - 单图 > 2MB → 跳过，降级为路径链接
 * - 报告总大小 > 20MB → 停止内联剩余图表
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { extname } from "node:path";

/** 单图最大字节数（2MB） */
const MAX_SINGLE_IMAGE_BYTES = 2 * 1024 * 1024;

/** 报告中内联图表的总大小上限（20MB） */
const MAX_TOTAL_INLINE_BYTES = 20 * 1024 * 1024;

/** 图表产出的工具名 */
const CHART_TOOL_NAMES = new Set(["visualize", "show_image"]);

/** 图片扩展名 → MIME 类型 */
const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** 内联结果 */
export interface InlineResult {
  /** 是否被内联 */
  inlined: boolean;
  /** 原始路径 */
  originalPath: string;
  /** base64 data URI（仅 inlined=true 时有值） */
  dataUri?: string;
  /** 文件大小（字节） */
  fileSizeBytes: number;
  /** 降级原因（仅 inlined=false 时有值） */
  skipReason?: string;
}

/**
 * 从 transcript 的工具调用中提取所有图表文件路径
 *
 * 扫描 assistant 消息的 toolCalls 中 visualize / show_image 的 output_path / file_path 参数。
 */
export function extractChartPaths(transcript: { toolCalls?: Array<{ name: string; argsSummary: string }> }[]): string[] {
  const paths: string[] = [];

  for (const msg of transcript) {
    if (!msg.toolCalls) continue;

    for (const tc of msg.toolCalls) {
      if (!CHART_TOOL_NAMES.has(tc.name)) continue;

      // 从参数摘要中提取路径（参数是 JSON 字符串）
      try {
        const args = JSON.parse(tc.argsSummary);
        const path = args.output_path ?? args.file_path;
        if (typeof path === "string" && path.length > 0) {
          paths.push(path);
        }
      } catch {
        // argsSummary 可能已被截断（加了 "..."），JSON.parse 失败时跳过
        // 尝试正则提取路径
        const pathMatch = tc.argsSummary.match(/(?:output_path|file_path)["\s:]+(["'])([^"']+)\1/);
        if (pathMatch) {
          paths.push(pathMatch[2]);
        }
      }
    }
  }

  // 去重
  return [...new Set(paths)];
}

/**
 * 获取文件的 MIME 类型
 */
function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

/**
 * 将图表文件转为 base64 data URI
 *
 * @returns base64 字符串，如果文件不存在或读取失败则返回 null
 */
export function fileToDataUri(filePath: string): string | null {
  if (!existsSync(filePath)) return null;

  try {
    const data = readFileSync(filePath);
    const mimeType = getMimeType(filePath);
    const base64 = data.toString("base64");
    return `data:${mimeType};base64,${base64}`;
  } catch {
    return null;
  }
}

/**
 * 批量内联图表，带阈值控制
 *
 * @param chartPaths - 图表文件路径列表
 * @param currentReportSize - 当前报告已有大小（不含图表），用于计算总大小
 * @returns 内联结果列表
 */
export function inlineChartAssets(
  chartPaths: string[],
  currentReportSize: number = 0
): InlineResult[] {
  const results: InlineResult[] = [];
  let totalInlineBytes = 0;

  for (const path of chartPaths) {
    // 检查文件是否存在
    if (!existsSync(path)) {
      results.push({
        inlined: false,
        originalPath: path,
        fileSizeBytes: 0,
        skipReason: "文件不存在",
      });
      continue;
    }

    const stats = statSync(path);
    const fileSize = stats.size;

    // 单图过大检查
    if (fileSize > MAX_SINGLE_IMAGE_BYTES) {
      results.push({
        inlined: false,
        originalPath: path,
        fileSizeBytes: fileSize,
        skipReason: `文件过大 (${(fileSize / 1024 / 1024).toFixed(1)}MB > 2MB 限制)`,
      });
      continue;
    }

    // 报告总大小检查
    if (currentReportSize + totalInlineBytes + fileSize > MAX_TOTAL_INLINE_BYTES) {
      results.push({
        inlined: false,
        originalPath: path,
        fileSizeBytes: fileSize,
        skipReason: "报告总大小超限（已达到 20MB 上限）",
      });
      // 标记剩余图表也跳过
      const remainingPaths = chartPaths.slice(chartPaths.indexOf(path) + 1);
      for (const rp of remainingPaths) {
        results.push({
          inlined: false,
          originalPath: rp,
          fileSizeBytes: 0,
          skipReason: "报告总大小超限（前置图表已占满 20MB 配额）",
        });
      }
      break;
    }

    // 读取并转为 data URI
    const dataUri = fileToDataUri(path);
    if (dataUri) {
      totalInlineBytes += fileSize;
      results.push({
        inlined: true,
        originalPath: path,
        dataUri,
        fileSizeBytes: fileSize,
      });
    } else {
      results.push({
        inlined: false,
        originalPath: path,
        fileSizeBytes: fileSize,
        skipReason: "文件读取失败",
      });
    }
  }

  return results;
}