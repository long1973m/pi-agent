/**
 * render-report — 组装数据 → 调模板 → 输出 HTML 字符串
 *
 * 整合 session-transcript、inline-assets、html-template、dictionary-panel、build-index 五个模块。
 */

import { getSessionTranscript, mergeToolResults, extractTableNamesFromSession } from "./session-transcript.js";
import { extractChartPaths, inlineChartAssets, type InlineResult } from "./inline-assets.js";
import { renderMessages, renderChartsSection, renderToc, buildHtmlFrame } from "./html-template.js";
import { renderDictionaryPanel } from "./dictionary-panel.js";
import { buildReportIndex } from "./build-index.js";
import type { DataDictionaryEntry } from "../types.js";

/** 报告渲染参数 */
export interface RenderReportParams {
  /** 原始 session entries */
  entries: Array<{ type: string; id: string; parentId: string | null; timestamp: string; message?: unknown }>;
  /** 报告标题 */
  title: string;
  /** 生成时间 */
  generatedAt: string;
  /** 数据字典条目（可选） */
  dictionaryEntries?: DataDictionaryEntry[];
  /** 报告摘要（用于 meta summary） */
  metaSummary?: string;
  /** reports 目录路径（用于生成索引页） */
  reportsDir?: string;
}

/** 报告渲染结果 */
export interface RenderReportResult {
  /** HTML 字符串 */
  html: string;
  /** 消息数量（过滤后） */
  messageCount: number;
  /** 图表数量 */
  chartCount: number;
  /** 内联成功的图表数量 */
  inlinedChartCount: number;
  /** HTML 字符串大小（字节） */
  htmlSizeBytes: number;
}

/**
 * 渲染完整报告
 */
export function renderReport(params: RenderReportParams): RenderReportResult {
  const { entries, title, generatedAt, dictionaryEntries, metaSummary, reportsDir } = params;

  // 1. 提取 transcript
  const transcript = getSessionTranscript(entries as Parameters<typeof getSessionTranscript>[0]);

  // 2. 合并工具调用结果
  const merged = mergeToolResults(transcript);

  // 3. 提取图表路径
  const chartPaths = extractChartPaths(merged);

  // 4. 过滤字典：只保留当前 session 用过的数据集（减少干扰）
  const usedTables = extractTableNamesFromSession(merged);
  const filteredDict = dictionaryEntries && usedTables.length > 0
    ? dictionaryEntries.filter((e) => usedTables.includes(e.tableName))
    : dictionaryEntries;

  // 5. 先渲染不含图表的 HTML 以计算基础大小
  const messagesHtml = renderMessages(merged);
  const tocHtml = renderToc(merged);
  const dictPanelHtml = filteredDict && filteredDict.length > 0
    ? renderDictionaryPanel(filteredDict)
    : "";
  const indexLinkHtml = reportsDir
    ? `<p class="index-link"><a href="./index.html">📁 查看全部历史报告</a></p>`
    : "";

  // meta datasets 用于索引页标签
  const metaDatasets = filteredDict?.map((e) => e.tableName).join(",") ?? "";

  const baseHtml = buildHtmlFrame({
    title, generatedAt, messagesHtml,
    chartsHtml: "", tocHtml, dictPanelHtml,
    metaSummary, metaDatasets, indexLinkHtml,
  });
  const baseSizeBytes = Buffer.byteLength(baseHtml, "utf-8");

  // 5. 内联图表
  const inlineResults: InlineResult[] = chartPaths.length > 0
    ? inlineChartAssets(chartPaths, baseSizeBytes)
    : [];

  // 6. 渲染图表区块
  const chartsHtml = renderChartsSection(inlineResults);

  // 7. 组装最终 HTML
  const html = buildHtmlFrame({
    title, generatedAt, messagesHtml, chartsHtml, tocHtml,
    dictPanelHtml, metaSummary, metaDatasets, indexLinkHtml,
  });

  // 8. 更新索引页（不阻塞，失败不影响报告生成 — 红线 R6）
  if (reportsDir) {
    try {
      buildReportIndex(reportsDir);
    } catch {
      // 索引页是附加功能，失败不阻塞
    }
  }

  // 统计
  const messageCount = merged.filter(
    (m) => m.role === "user" || m.role === "assistant"
  ).length;

  const inlinedChartCount = inlineResults.filter((r) => r.inlined).length;

  return {
    html,
    messageCount,
    chartCount: chartPaths.length,
    inlinedChartCount,
    htmlSizeBytes: Buffer.byteLength(html, "utf-8"),
  };
}
