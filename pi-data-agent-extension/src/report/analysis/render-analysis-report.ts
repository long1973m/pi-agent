/**
 * Task 4 — 正式分析报告 HTML 渲染器
 *
 * 将 AnalysisReportDraft + EvidencePackage 渲染为自包含 HTML。
 * 视觉要求（Spec §7.3）：
 * - 开头直接展示执行摘要，不展示聊天记录
 * - 每个关键发现使用"结论 -> 证据 -> 图表 -> 解释"的顺序
 * - SQL 默认放入折叠附录
 * - 字典与口径默认放入附录
 * - 支持离线打开（内联 CSS，不依赖外部资源）
 * - 与 Dashboard 现有主题保持一致（Catppuccin Mocha 暗色 / Latte 亮色）
 * - 打印和导出 PDF 时不出现导航按钮、调试信息和交互控件
 */

import type { AnalysisReportDraft } from "./report-draft-schema.js";
import type { EvidencePackage } from "../evidence/types.js";
import { resolve } from "node:path";

// ============================================================================
// 参数与返回类型
// ============================================================================

export interface RenderAnalysisReportParams {
  draft: AnalysisReportDraft;
  evidence: EvidencePackage;
  reportId: string;
  sourceSessionReportId: string;
  sourceSessionId: string;
  generatedAt: string;
  reportsDir: string;
}

export interface RenderAnalysisReportResult {
  html: string;
  htmlSizeBytes: number;
}

// ============================================================================
// CSS 主题（与 html-template.ts 的 Catppuccin 变量对齐）
// ============================================================================

const ANALYSIS_CSS = `
/* === Catppuccin 深浅色主题切换 === */
:root {
  --bg: #1e1e2e;
  --bg-secondary: #181825;
  --bg-surface: #313244;
  --fg: #cdd6f4;
  --fg-muted: #a6adc8;
  --accent: #a6e3a1;
  --accent-secondary: #89b4fa;
  --red: #f38ba8;
  --yellow: #f9e2af;
  --peach: #fab387;
  --border: #45475a;
  --code-bg: #11111b;
  --radius: 8px;
  --max-width: 960px;
  --hypothesis-border: #f9e2af;
  --hypothesis-bg: rgba(249, 226, 175, 0.06);
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: #eff1f5;
    --bg-secondary: #e6e9ef;
    --bg-surface: #ccd0da;
    --fg: #4c4f69;
    --fg-muted: #6c6f85;
    --accent: #40a02b;
    --accent-secondary: #1e66f5;
    --red: #d20f39;
    --yellow: #df8e1d;
    --peach: #fe640b;
    --border: #bcc0cc;
    --code-bg: #dce0e8;
    --hypothesis-border: #df8e1d;
    --hypothesis-bg: rgba(223, 142, 29, 0.06);
  }
}

/* === 基础 === */
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif;
  font-size: 15px;
  line-height: 1.7;
  padding: 24px 20px;
}

.container {
  max-width: var(--max-width);
  margin: 0 auto;
}

/* === Header === */
.header {
  padding: 28px 0 20px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 32px;
}

.header .title {
  font-size: 24px;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 8px;
}

.header .meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 12px;
  color: var(--fg-muted);
}

.header .meta-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 4px;
}

/* === 导航目录 === */
.toc {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 20px;
  margin-bottom: 32px;
}

.toc-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--accent-secondary);
  margin-bottom: 10px;
}

.toc-list {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.toc-list li {
  margin: 0;
}

.toc-list a {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 4px;
  text-decoration: none;
  color: var(--fg-muted);
  font-size: 13px;
  transition: background 0.15s, color 0.15s;
}

.toc-list a:hover {
  background: var(--bg-surface);
  color: var(--fg);
}

/* === Section 通用 === */
.report-section {
  margin-bottom: 36px;
}

.section-heading {
  font-size: 18px;
  font-weight: 700;
  color: var(--accent-secondary);
  padding-bottom: 8px;
  border-bottom: 2px solid var(--border);
  margin-bottom: 16px;
}

.section-body {
  font-size: 15px;
  line-height: 1.7;
}

.section-body p {
  margin-bottom: 12px;
}

/* === 执行摘要 === */
.exec-summary-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.exec-summary-item {
  background: var(--bg-surface);
  border-left: 4px solid var(--accent);
  border-radius: 0 var(--radius) var(--radius) 0;
  padding: 14px 18px;
}

.exec-summary-item .summary-text {
  font-size: 15px;
  font-weight: 500;
  line-height: 1.6;
}

/* === 发现卡片 === */
.finding-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  margin-bottom: 20px;
}

.finding-card.hypothesis {
  border: 2px solid var(--hypothesis-border);
  background: var(--hypothesis-bg);
}

.finding-card .finding-heading {
  font-size: 16px;
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.finding-card .finding-conclusion {
  font-size: 15px;
  line-height: 1.7;
  margin-bottom: 14px;
}

.finding-card .finding-interpretation {
  font-size: 14px;
  color: var(--fg-muted);
  border-top: 1px solid var(--border);
  padding-top: 10px;
  margin-top: 10px;
}

.hypothesis-badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(249, 226, 175, 0.15);
  color: var(--yellow);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  white-space: nowrap;
}

/* === 图表 === */
.chart-container {
  margin: 16px 0;
  text-align: center;
}

.chart-container img {
  max-width: 100%;
  border-radius: var(--radius);
  border: 1px solid var(--border);
}

.chart-caption {
  font-size: 12px;
  color: var(--fg-muted);
  margin-top: 6px;
}

.chart-unavailable {
  padding: 12px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--fg-muted);
  font-size: 13px;
}

/* === 建议 === */
.recommendation-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.recommendation-item {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 18px;
  border-left: 4px solid var(--accent-secondary);
}

.recommendation-item.priority-high { border-left-color: var(--red); }
.recommendation-item.priority-medium { border-left-color: var(--yellow); }
.recommendation-item.priority-low { border-left-color: var(--fg-muted); }

.rec-action {
  font-weight: 600;
  margin-bottom: 6px;
}

.rec-rationale {
  font-size: 14px;
  color: var(--fg-muted);
}

.priority-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  margin-left: 8px;
}

.priority-badge.high { background: rgba(243, 139, 168, 0.15); color: var(--red); }
.priority-badge.medium { background: rgba(249, 226, 175, 0.15); color: var(--yellow); }
.priority-badge.low { background: rgba(166, 173, 200, 0.15); color: var(--fg-muted); }

/* === Limitations === */
.limitation-list {
  list-style: disc;
  padding-left: 24px;
}

.limitation-list li {
  margin-bottom: 8px;
  font-size: 14px;
  color: var(--fg-muted);
}

.limitation-list.evidence-limitations {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.limitation-list.evidence-limitations li::marker {
  color: var(--yellow);
}

/* === 附录 === */
.appendix-section details {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 12px;
  overflow: hidden;
}

.appendix-section summary {
  padding: 10px 16px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  color: var(--accent-secondary);
  user-select: none;
}

.appendix-section summary:hover {
  background: var(--bg-surface);
}

.appendix-section summary::-webkit-details-marker {
  display: none;
}

.appendix-content {
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  font-size: 13px;
}

/* === SQL 代码块 === */
.sql-block {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px 14px;
  margin: 8px 0;
  overflow-x: auto;
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--fg);
}

.sql-label {
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", monospace;
  font-size: 10px;
  font-weight: 700;
  color: var(--accent-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}

/* === 字段口径表格 === */
.caliber-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin: 8px 0;
}

.caliber-table th {
  text-align: left;
  padding: 6px 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  font-weight: 600;
  color: var(--accent-secondary);
  font-size: 12px;
}

.caliber-table td {
  padding: 6px 10px;
  border: 1px solid var(--border);
  color: var(--fg);
}

/* === 字典表格 === */
.dict-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin: 8px 0;
}

.dict-table th {
  text-align: left;
  padding: 6px 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  font-weight: 600;
  color: var(--accent-secondary);
  font-size: 12px;
}

.dict-table td {
  padding: 6px 10px;
  border: 1px solid var(--border);
  color: var(--fg);
}

.dict-table .status-validated { color: var(--accent); }
.dict-table .status-ai-guessed { color: var(--yellow); }
.dict-table .status-uncertain { color: var(--red); }

/* === Footer === */
.footer {
  padding-top: 20px;
  border-top: 1px solid var(--border);
  text-align: center;
  color: var(--fg-muted);
  font-size: 12px;
  opacity: 0.6;
}

/* === 打印样式 === */
@media print {
  body { padding: 0; background: #fff; color: #000; }
  .toc, .theme-toggle { display: none !important; }
  .finding-card, .exec-summary-item, .recommendation-item { break-inside: avoid; }
  :root {
    --bg: #fff; --bg-secondary: #f5f5f5; --bg-surface: #eee;
    --fg: #000; --fg-muted: #555; --border: #ccc;
    --accent: #2e7d32; --accent-secondary: #1565c0;
    --red: #c62828; --yellow: #f57f17;
  }
}
`;

// ============================================================================
// 核心渲染函数
// ============================================================================

/**
 * 渲染正式分析报告 HTML
 */
export function renderAnalysisReport(
  params: RenderAnalysisReportParams
): RenderAnalysisReportResult {
  const { draft, evidence, reportId, sourceSessionReportId, sourceSessionId, generatedAt, reportsDir } = params;

  const htmlParts: string[] = [];

  // 1. DOCTYPE + head
  htmlParts.push(buildHead(draft, evidence, reportId, generatedAt, sourceSessionReportId));

  // 2. Body 开始
  htmlParts.push('<body><div class="container">');

  // 3. Header
  htmlParts.push(renderHeader(draft, evidence, generatedAt, sourceSessionReportId));

  // 4. TOC
  htmlParts.push(renderToc(draft));

  // 5. Executive Summary
  htmlParts.push(renderExecutiveSummary(draft));

  // 6. Background
  if (draft.background) {
    htmlParts.push(renderSection("background", "分析背景", renderMarkdown(draft.background)));
  }

  // 7. Scope
  htmlParts.push(renderScopeSection(draft, evidence));

  // 8. Findings
  htmlParts.push(renderFindings(draft, evidence, reportsDir));

  // 9. Recommendations
  if (draft.recommendations.length > 0) {
    htmlParts.push(renderRecommendations(draft));
  }

  // 10. Limitations
  htmlParts.push(renderLimitations(draft, evidence));

  // 11. Appendix
  htmlParts.push(renderAppendix(evidence, sourceSessionId, sourceSessionReportId));

  // 12. Footer
  htmlParts.push(renderFooter());

  // 13. Body 结束
  htmlParts.push('</div></body></html>');

  const html = htmlParts.join("\n");
  return { html, htmlSizeBytes: Buffer.byteLength(html, "utf-8") };
}

// ============================================================================
// HTML 片段构建函数
// ============================================================================

function buildHead(
  draft: AnalysisReportDraft,
  evidence: EvidencePackage,
  reportId: string,
  generatedAt: string,
  sourceSessionReportId?: string
): string {
  const summaryMeta = draft.executiveSummary
    .slice(0, 3)
    .map((e) => e.text)
    .join("; ");
  const datasetsMeta = evidence.scope.datasets.join(", ");
  const modeMeta = evidence.reportMode;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="summary" content="${esc(summaryMeta.slice(0, 500))}">
<meta name="datasets" content="${esc(datasetsMeta)}">
<meta name="report-mode" content="${esc(modeMeta)}">
<meta name="generated-at" content="${esc(generatedAt)}">
<meta name="report-id" content="${esc(reportId)}">
<meta name="source-session-id" content="${esc(evidence.sessionId)}">
<meta name="source-session-report-id" content="${esc(sourceSessionReportId || "")}">
<title>${esc(draft.title)}</title>
<style>
${ANALYSIS_CSS}
</style>
</head>`;
}

function renderHeader(
  draft: AnalysisReportDraft,
  evidence: EvidencePackage,
  generatedAt: string,
  sourceSessionReportId: string
): string {
  const modeLabel = evidence.reportMode === "executive" ? "Executive" : "Detailed";
  const datasetsTags = evidence.scope.datasets
    .map((ds) => `<span class="meta-tag">${esc(ds)}</span>`)
    .join("");
  const dateRange = evidence.scope.dateRange
    ? `${evidence.scope.dateRange.start} ~ ${evidence.scope.dateRange.end}`
    : "";

  return `
<header class="header">
  <h1 class="title">${esc(draft.title)}</h1>
  <div class="meta-row">
    <span class="meta-tag">${esc(modeLabel)}</span>
    ${datasetsTags}
    ${dateRange ? `<span class="meta-tag">${esc(dateRange)}</span>` : ""}
    <span class="meta-tag">Generated: ${esc(formatTimestamp(generatedAt))}</span>
    ${sourceSessionReportId ? `<span class="meta-tag">Source: ${esc(sourceSessionReportId)}</span>` : ""}
  </div>
</header>`;
}

function renderToc(draft: AnalysisReportDraft): string {
  const items: string[] = [];

  if (draft.executiveSummary.length > 0) items.push('<a href="#executive-summary">执行摘要</a>');
  if (draft.background) items.push('<a href="#background">分析背景</a>');
  items.push('<a href="#scope">数据范围与口径</a>');
  if (draft.sections.length > 0) items.push('<a href="#findings">关键发现</a>');
  if (draft.recommendations.length > 0) items.push('<a href="#recommendations">行动建议</a>');
  items.push('<a href="#limitations">风险与限制</a>');
  items.push('<a href="#appendix">附录</a>');

  return `
<nav class="toc">
  <h2 class="toc-title">目录</h2>
  <ul class="toc-list">${items.map((i) => `<li>${i}</li>`).join("\n")}</ul>
</nav>`;
}

function renderExecutiveSummary(draft: AnalysisReportDraft): string {
  const items = draft.executiveSummary
    .map((item) => `
    <li class="exec-summary-item">
      <div class="summary-text">${renderMarkdown(item.text)}</div>
    </li>`)
    .join("\n");

  return `
<section id="executive-summary" class="report-section">
  <h2 class="section-heading">执行摘要</h2>
  <div class="section-body">
    <ul class="exec-summary-list">
      ${items}
    </ul>
  </div>
</section>`;
}

function renderScopeSection(
  draft: AnalysisReportDraft,
  evidence: EvidencePackage
): string {
  let body = "";

  if (draft.scope) {
    body += renderMarkdown(draft.scope);
  }

  // 展示数据集信息
  if (evidence.scope.datasets.length > 0) {
    body += `<p><strong>数据集：</strong>${evidence.scope.datasets.map((ds) => esc(ds)).join("、")}</p>`;
  }

  if (evidence.scope.dateRange) {
    body += `<p><strong>时间范围：</strong>${esc(evidence.scope.dateRange.start)} ~ ${esc(evidence.scope.dateRange.end)}</p>`;
  }

  if (evidence.scope.filters.length > 0) {
    body += `<p><strong>筛选条件：</strong>`;
    body += evidence.scope.filters
      .map((f) => `${esc(f.field)} ${esc(f.operator)} ${esc(String(f.value))}`)
      .join("；");
    body += `</p>`;
  }

  return `
<section id="scope" class="report-section">
  <h2 class="section-heading">数据范围与业务口径</h2>
  <div class="section-body">${body}</div>
</section>`;
}

function renderFindings(
  draft: AnalysisReportDraft,
  evidence: EvidencePackage,
  reportsDir: string
): string {
  if (draft.sections.length === 0) return "";

  const cards = draft.sections.map((section) => {
    const isHypothesis = section.interpretationType === "hypothesis";
    const hypothesisClass = isHypothesis ? " hypothesis" : "";
    const hypothesisBadge = isHypothesis
      ? '<span class="hypothesis-badge">待验证</span>'
      : "";

    // 图表渲染
    let chartsHtml = "";
    if (section.chartRefs.length > 0) {
      chartsHtml = section.chartRefs
        .map((chartRef) => {
          const chart = evidence.charts.find((c) => c.id === chartRef);
          if (!chart) return `<div class="chart-unavailable">Chart "${esc(chartRef)}" not found</div>`;

          // 优先使用 dataUrl
          if (chart.dataUrl) {
            return `<div class="chart-container">
  <img src="${chart.dataUrl}" alt="${esc(chart.title)}" />
  <p class="chart-caption">${esc(chart.title)}</p>
</div>`;
          }

          // 尝试通过 filePath 读取并内联（同步方式：标记为文件路径）
          if (chart.filePath) {
            const absPath = resolve(reportsDir, chart.filePath);
            return `<div class="chart-container">
  <img src="${esc(absPath)}" alt="${esc(chart.title)}" onerror="this.parentElement.innerHTML='<div class=\\'chart-unavailable\\'>Chart file not found: ${esc(chart.filePath)}</div>'" />
  <p class="chart-caption">${esc(chart.title)}</p>
</div>`;
          }

          return `<div class="chart-unavailable">No image data for chart "${esc(chart.title)}"</div>`;
        })
        .join("\n");
    }

    // 解读文本
    const interpretationHtml = section.interpretation
      ? `<div class="finding-interpretation"><strong>解读：</strong>${renderMarkdown(section.interpretation)}</div>`
      : "";

    // 证据引用信息
    let evidenceInfo = "";
    if (section.evidenceRefs.length > 0) {
      const refLabels = section.evidenceRefs.map((ref) => {
        // 尝试找到对应的 finding 或 query
        const finding = evidence.findings.find((f) => f.id === ref);
        if (finding) return esc(finding.statement.slice(0, 80));
        const query = evidence.queries.find((q) => q.id === ref);
        if (query) return esc(query.naturalLanguageQuery.slice(0, 80));
        return esc(ref);
      });
      evidenceInfo = `<div class="finding-interpretation"><strong>证据来源：</strong>${refLabels.join("；")}</div>`;
    }

    return `
    <div class="finding-card${hypothesisClass}">
      <div class="finding-heading">${hypothesisBadge}${esc(section.heading)}</div>
      <div class="finding-conclusion">${renderMarkdown(section.conclusion)}</div>
      ${chartsHtml}
      ${evidenceInfo}
      ${interpretationHtml}
    </div>`;
  });

  return `
<section id="findings" class="report-section">
  <h2 class="section-heading">关键发现</h2>
  <div class="section-body">
    ${cards.join("\n")}
  </div>
</section>`;
}

function renderRecommendations(draft: AnalysisReportDraft): string {
  const items = draft.recommendations.map((rec) => {
    const priorityClass = `priority-${rec.priority}`;
    return `
    <li class="recommendation-item ${priorityClass}">
      <div class="rec-action">
        ${esc(rec.action)}
        <span class="priority-badge ${rec.priority}">${rec.priority}</span>
      </div>
      <div class="rec-rationale">${renderMarkdown(rec.rationale)}</div>
    </li>`;
  });

  return `
<section id="recommendations" class="report-section">
  <h2 class="section-heading">行动建议</h2>
  <div class="section-body">
    <ul class="recommendation-list">
      ${items.join("\n")}
    </ul>
  </div>
</section>`;
}

function renderLimitations(
  draft: AnalysisReportDraft,
  evidence: EvidencePackage
): string {
  let body = "";

  // Report Draft 中的 limitations
  if (draft.limitations.length > 0) {
    body += `<ul class="limitation-list">
      ${draft.limitations.map((l) => `<li>${renderMarkdown(l)}</li>`).join("\n")}
    </ul>`;
  } else {
    body += `<p style="color:var(--fg-muted)">未标注额外限制事项。</p>`;
  }

  // Evidence Package 中的高严重度 limitation
  const highLimitations = evidence.limitations.filter((l) => l.severity === "high" || l.severity === "medium");
  if (highLimitations.length > 0) {
    body += `
    <p style="margin-top: 12px; font-size: 13px; color: var(--fg-muted);">
      <strong>证据包中已识别的数据限制：</strong>
    </p>
    <ul class="limitation-list evidence-limitations">
      ${highLimitations.map((l) => `<li>[${l.severity.toUpperCase()}] ${esc(l.description)}</li>`).join("\n")}
    </ul>`;
  }

  return `
<section id="limitations" class="report-section">
  <h2 class="section-heading">风险、限制与待验证事项</h2>
  <div class="section-body">${body}</div>
</section>`;
}

function renderAppendix(
  evidence: EvidencePackage,
  sourceSessionId: string,
  sourceSessionReportId: string
): string {
  const parts: string[] = [];

  // 证据索引
  if (evidence.findings.length > 0) {
    const findingRows = evidence.findings
      .map(
        (f) => `<tr>
  <td>${esc(f.id)}</td>
  <td>${esc(f.evidenceType)}</td>
  <td>${esc(f.confidence)}</td>
  <td>${esc(f.statement.slice(0, 120))}</td>
</tr>`
      )
      .join("\n");

    parts.push(`
<details>
  <summary>证据索引（${evidence.findings.length} 条发现）</summary>
  <div class="appendix-content">
    <table class="caliber-table">
      <thead><tr><th>ID</th><th>类型</th><th>置信度</th><th>描述</th></tr></thead>
      <tbody>${findingRows}</tbody>
    </table>
  </div>
</details>`);
  }

  // 核心 SQL
  if (evidence.queries.length > 0) {
    const sqlBlocks = evidence.queries
      .map(
        (q) => `
    <div>
      <div class="sql-label">${esc(q.id)} — ${esc(q.naturalLanguageQuery.slice(0, 60))}</div>
      <pre class="sql-block">${esc(q.sql)}</pre>
    </div>`
      )
      .join("\n");

    parts.push(`
<details>
  <summary>核心 SQL（${evidence.queries.length} 条查询）</summary>
  <div class="appendix-content">${sqlBlocks}</div>
</details>`);
  }

  // 字段口径（字典）
  if (evidence.dictionary.length > 0) {
    const dictBlocks = evidence.dictionary
      .map(
        (d) => `
    <div style="margin-bottom: 12px">
      <strong style="color:var(--accent)">${esc(d.table)}</strong>
      <table class="dict-table">
        <thead><tr><th>字段名</th><th>类型</th><th>含义</th><th>状态</th></tr></thead>
        <tbody>
          ${d.columns
            .map(
              (c) => `<tr>
  <td><code>${esc(c.name)}</code></td>
  <td>${esc(c.type)}</td>
  <td>${esc(c.meaning)}</td>
  <td class="status-${c.status}">${esc(c.status)}</td>
</tr>`
            )
            .join("\n")}
        </tbody>
      </table>
    </div>`
      )
      .join("\n");

    parts.push(`
<details>
  <summary>字段口径字典（${evidence.dictionary.length} 张表）</summary>
  <div class="appendix-content">${dictBlocks}</div>
</details>`);
  }

  // 口径定义
  if (evidence.metrics.length > 0) {
    const metricRows = evidence.metrics
      .map(
        (m) => `<tr>
  <td>${esc(m.name)}</td>
  <td>${esc(m.definition)}</td>
  <td>${esc(m.confirmedAt)}</td>
</tr>`
      )
      .join("\n");

    parts.push(`
<details>
  <summary>口径定义（${evidence.metrics.length} 条）</summary>
  <div class="appendix-content">
    <table class="caliber-table">
      <thead><tr><th>口径</th><th>定义</th><th>确认时间</th></tr></thead>
      <tbody>${metricRows}</tbody>
    </table>
  </div>
</details>`);
  }

  // Session Report 链接
  if (sourceSessionReportId) {
    parts.push(`
<details>
  <summary>来源 Session Report</summary>
  <div class="appendix-content">
    <p>Session Report ID: <code>${esc(sourceSessionReportId)}</code></p>
    <p>Session ID: <code>${esc(sourceSessionId)}</code></p>
  </div>
</details>`);
  }

  return `
<section id="appendix" class="report-section appendix-section">
  <h2 class="section-heading">附录</h2>
  ${parts.join("\n")}
</section>`;
}

function renderFooter(): string {
  return `
<footer class="footer">
  <p>Generated by Pi Data Agent v0.7 &middot; Analysis Report &middot; Offline self-contained</p>
</footer>`;
}

// ============================================================================
// 辅助工具函数
// ============================================================================

/** HTML 转义 */
function esc(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 格式化 ISO 时间戳 */
function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return ts;
  }
}

/** 简单 Markdown 渲染（支持段落、粗体、行内代码、代码块） */
function renderMarkdown(text: string): string {
  if (!text) return "";
  let html = esc(text);

  // 代码块
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_m, _lang, code) => `<pre class="sql-block">${code.trim()}</pre>`
  );

  // 粗体
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code style="background:var(--bg-surface);padding:1px 4px;border-radius:3px;font-family:monospace;font-size:12px;">$1</code>');

  // 换行
  html = html.replace(/\n/g, "<br>");

  return html;
}

/**
 * 渲染 section 通用包装
 */
function renderSection(id: string, heading: string, bodyHtml: string): string {
  return `
<section id="${esc(id)}" class="report-section">
  <h2 class="section-heading">${esc(heading)}</h2>
  <div class="section-body">
    <p>${bodyHtml}</p>
  </div>
</section>`;
}
