/**
 * Task 4 — 报告索引页构建 + manifest.json 生成
 *
 * 扫描 <cwd>/reports/ 下所有 session-*.html 和 analysis-*.html，
 * 提取时间戳和 <meta name="summary">，生成 index.html 和 manifest.json。
 *
 * 特性：
 * - 按时间倒序排列
 * - 无 meta 的旧报告 fallback 到文件名 + "无摘要"
 * - 报告文件被删除 → 显示"已移除"
 * - 不做搜索、不分页
 * - manifest.json 持久化，revision 递增
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

/** 报告类型 */
type ReportType = "session" | "analysis";

/** 单条报告记录（内部使用） */
interface ReportEntry {
  filename: string;
  filepath: string;
  timestamp: number;
  summary: string;
  datasets: string[];
  type: ReportType;
  /** analysis 报告专属 */
  sourceSessionId?: string;
  sourceSessionReportId?: string;
  reportMode?: "executive" | "detailed";
  evidenceCoverage?: number;
  /** session 报告关联的 analysis ID 列表 */
  analysisReportIds?: string[];
}

/** manifest.json 中单条记录 */
interface ManifestReportEntry {
  id: string;
  type: ReportType;
  title: string;
  summary: string;
  createdAt: string;
  file: string;
  datasets: string[];
  charts: Array<{
    id: string;
    title: string;
    generatedAt: string;
    dataset?: string;
  }>;
  sourceSessionId?: string;
  sourceSessionReportId?: string;
  reportMode?: "executive" | "detailed";
  evidenceCoverage?: number;
  analysisReportIds?: string[];
}

/** manifest.json 结构 */
interface ReportManifest {
  revision: number;
  reports: ManifestReportEntry[];
}

/**
 * 构建报告索引页 + manifest.json
 *
 * @param reportsDir - reports 目录路径
 * @returns 是否成功生成
 */
export function buildReportIndex(reportsDir: string): boolean {
  try {
    if (!existsSync(reportsDir)) {
      return false;
    }

    const files = readdirSync(reportsDir)
      .filter(
        (f) =>
          (f.startsWith("session-") || f.startsWith("analysis-")) &&
          f.endsWith(".html")
      )
      .map((f) => parseReportEntry(join(reportsDir, f)))
      .sort((a, b) => b.timestamp - a.timestamp); // 倒序

    // 先生成 manifest.json
    buildManifest(reportsDir, files);

    // 再生成 index.html
    const html = generateIndexHtml(files, basename(reportsDir));
    const indexPath = join(reportsDir, "index.html");
    writeFileSync(indexPath, html, "utf-8");

    console.log(
      `[build-index] Index generated: ${indexPath} (${files.length} reports)`
    );
    return true;
  } catch (err) {
    console.warn(
      `[build-index] Failed to build index: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

/**
 * 构建 manifest.json
 *
 * - 扫描 HTML 文件提取元信息
 * - 若已有 manifest.json，读取 revision 并递增
 * - 原子写入（临时文件 → 校验 → rename）
 */
export function buildManifest(
  reportsDir: string,
  entries: ReportEntry[]
): void {
  const manifestPath = join(reportsDir, "manifest.json");

  // 读取现有 revision
  let revision = 0;
  if (existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(
        readFileSync(manifestPath, "utf-8")
      ) as ReportManifest;
      revision = existing.revision ?? 0;
    } catch {
      // 解析失败，从 0 开始
    }
  }

  const newRevision = revision + 1;

  const reports: ManifestReportEntry[] = entries.map((e) => {
    const id = e.filename.replace(".html", "");
    const title = extractTitle(join(reportsDir, e.filename)) || id;
    const createdAt = new Date(e.timestamp).toISOString();
    const charts = extractCharts(join(reportsDir, e.filename), id, e.filename, createdAt, e.datasets);

    const entry: ManifestReportEntry = {
      id,
      type: e.type,
      title,
      summary: e.summary,
      createdAt,
      file: e.filename,
      datasets: e.datasets,
      charts,
    };

    // analysis 专属字段
    if (e.type === "analysis") {
      if (e.sourceSessionId) entry.sourceSessionId = e.sourceSessionId;
      if (e.sourceSessionReportId)
        entry.sourceSessionReportId = e.sourceSessionReportId;
      if (e.reportMode) entry.reportMode = e.reportMode;
      if (e.evidenceCoverage !== undefined)
        entry.evidenceCoverage = e.evidenceCoverage;
    }

    // session 报告的 analysisReportIds
    if (e.analysisReportIds?.length) {
      entry.analysisReportIds = e.analysisReportIds;
    }

    return entry;
  });

  const manifest: ReportManifest = {
    revision: newRevision,
    reports,
  };

  // 原子写入
  atomicWriteJson(manifestPath, manifest);

  console.log(
    `[build-index] Manifest generated: ${manifestPath} (revision: ${newRevision}, ${reports.length} reports)`
  );
}

// =========================================================================
// Private helpers
// =========================================================================

/**
 * 解析单个报告文件信息
 */
function parseReportEntry(filepath: string): ReportEntry {
  const filename = basename(filepath);

  // 推断 type
  const type: ReportType = filename.startsWith("analysis-")
    ? "analysis"
    : "session";

  // 从文件名提取时间戳：session-<timestamp>.html 或 analysis-<timestamp>.html
  const tsMatch = filename.match(/(\d+)\.html$/);
  const timestamp = tsMatch ? parseInt(tsMatch[1], 10) : Date.now();

  // 尝试读取 meta summary 和 datasets
  let summary = "无摘要";
  let datasets: string[] = [];
  let sourceSessionId: string | undefined;
  let sourceSessionReportId: string | undefined;
  let reportMode: "executive" | "detailed" | undefined;
  let evidenceCoverage: number | undefined;

  try {
    const content = readFileSync(filepath, "utf-8");

    const summaryMatch = content.match(
      /<meta\s+name=["']summary["']\s+content=["']([^"']*)["']/i
    );
    if (summaryMatch) {
      summary = summaryMatch[1].trim() || "无摘要";
    }

    const datasetsMatch = content.match(
      /<meta\s+name=["']datasets["']\s+content=["']([^"']*)["']/i
    );
    if (datasetsMatch) {
      datasets = datasetsMatch[1].split(",").filter(Boolean);
    }

    // analysis 专属 meta
    if (type === "analysis") {
      const modeMatch = content.match(
        /<meta\s+name=["']report-mode["']\s+content=["']([^"']*)["']/i
      );
      if (modeMatch && (modeMatch[1] === "executive" || modeMatch[1] === "detailed")) {
        reportMode = modeMatch[1];
      }

      const coverageMatch = content.match(
        /<meta\s+name=["']evidence-coverage["']\s+content=["']([^"']*)["']/i
      );
      if (coverageMatch) {
        const parsed = parseFloat(coverageMatch[1]);
        if (!isNaN(parsed)) evidenceCoverage = parsed;
      }

      const srcSessionMatch = content.match(
        /<meta\s+name=["']source-session-id["']\s+content=["']([^"']*)["']/i
      );
      if (srcSessionMatch) sourceSessionId = srcSessionMatch[1].trim();

      const srcReportMatch = content.match(
        /<meta\s+name=["']source-session-report-id["']\s+content=["']([^"']*)["']/i
      );
      if (srcReportMatch) sourceSessionReportId = srcReportMatch[1].trim();
    }

    // 如果 meta 没有提供，尝试从文件名推断
    if (!sourceSessionReportId) {
      const analysisMatch = filename.match(
        /^analysis-(session-\d+)-(\d+)\.html$/
      );
      if (analysisMatch) {
        sourceSessionReportId = analysisMatch[1];
        sourceSessionId = analysisMatch[1].replace(/-\d+$/, "");
      }
    }
  } catch {
    // 读取失败不阻塞
  }

  const result: ReportEntry = {
    filename,
    filepath,
    timestamp,
    summary,
    datasets,
    type,
  };

  if (type === "analysis") {
    if (sourceSessionId) result.sourceSessionId = sourceSessionId;
    if (sourceSessionReportId) result.sourceSessionReportId = sourceSessionReportId;
    if (reportMode) result.reportMode = reportMode;
    if (evidenceCoverage !== undefined) result.evidenceCoverage = evidenceCoverage;
  }

  return result;
}

/**
 * 提取报告标题
 */
function extractTitle(filepath: string): string {
  try {
    const content = readFileSync(filepath, "utf-8");
    const match = content.match(/<title>([^<]+)<\/title>/i);
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

/**
 * 提取图表信息
 */
function extractCharts(
  filepath: string,
  reportId: string,
  filename: string,
  createdAt: string,
  datasets: string[]
): Array<{ id: string; title: string; generatedAt: string; dataset?: string }> {
  const charts: Array<{ id: string; title: string; generatedAt: string; dataset?: string }> = [];
  try {
    const content = readFileSync(filepath, "utf-8");
    const imgRegex =
      /<img\s+src="(data:image\/[^"]+|[^"]*\.(?:png|jpg|jpeg|svg))"[^>]*(?:alt=["']([^"']*)["'])?/gi;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(content)) !== null) {
      const alt = imgMatch[2] || "";
      const src = imgMatch[1];
      if (alt.includes("emoji") || (src.startsWith("data:") && src.length < 100))
        continue;
      charts.push({
        id: `chart_${charts.length}_${reportId}`,
        title: alt || `图表 ${charts.length + 1}`,
        generatedAt: createdAt,
        dataset: datasets[0],
      });
    }
  } catch {
    // 忽略
  }
  return charts;
}

/**
 * 生成索引页 HTML
 */
function generateIndexHtml(entries: ReportEntry[], dirName: string): string {
  const items = entries
    .map((e) => {
      const date = new Date(e.timestamp).toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

      const typeTag =
        e.type === "analysis"
          ? `<span class="idx-type idx-type-analysis">analysis</span>`
          : "";

      const datasetTags =
        e.datasets.length > 0
          ? `<span class="idx-datasets">${e.datasets.map((d) => `<span class="idx-tag">${escapeHtml(d)}</span>`).join("")}</span>`
          : "";

      return `
<a href="./${encodeURIComponent(e.filename)}" class="idx-item">
  <span class="idx-filename">${escapeHtml(e.filename)}</span>
  <span class="idx-summary">${escapeHtml(e.summary)}</span>
  ${typeTag}
  ${datasetTags}
  <span class="idx-date">${date}</span>
</a>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>分析会话报告索引</title>
<style>
${INDEX_CSS}
</style>
</head>
<body>
<div class="idx-container">
  <header class="idx-header">
    <h1 class="idx-title">分析会话报告索引</h1>
    <p class="idx-meta">${entries.length} 份报告 · ${dirName}/</p>
  </header>
  <div class="idx-list">
    ${items || '<p class="idx-empty">暂无报告</p>'}
  </div>
</div>
</body>
</html>`;
}

/** HTML 转义 */
function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 原子写入 JSON 文件
 *
 * 模式：tmp → JSON 校验 → rename
 * 与 AtomicStore 保持一致的写入策略
 */
function atomicWriteJson(filePath: string, data: unknown): void {
  const content = JSON.stringify(data, null, 2);
  const tmpPath = `${filePath}.tmp_${randomUUID()}`;

  // 写入临时文件
  writeFileSync(tmpPath, content, "utf-8");

  // 解析校验临时文件
  try {
    JSON.parse(readFileSync(tmpPath, "utf-8"));
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      // 忽略清理失败
    }
    throw new Error(`[build-index] JSON 写入校验失败: ${filePath}`);
  }

  // 原子替换
  try {
    if (existsSync(filePath)) {
      renameSync(filePath, `${filePath}.bak`);
    }
    renameSync(tmpPath, filePath);
  } catch (err) {
    // 回滚
    try {
      if (existsSync(`${filePath}.bak`)) {
        renameSync(`${filePath}.bak`, filePath);
      }
    } catch {
      // 忽略回滚失败
    }
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // 忽略
    }
    throw new Error(
      `[build-index] 原子替换失败: ${filePath} — ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 清理备份
  try {
    if (existsSync(`${filePath}.bak`)) {
      unlinkSync(`${filePath}.bak`);
    }
  } catch {
    // 忽略
  }
}

const INDEX_CSS = `
:root {
  --bg: #1e1e2e;
  --bg-secondary: #181825;
  --bg-surface: #313244;
  --fg: #cdd6f4;
  --fg-muted: #a6adc8;
  --accent: #a6e3a1;
  --accent-secondary: #89b4fa;
  --red: #f38ba8;
  --border: #45475a;
  --radius: 8px;
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
    --border: #bcc0cc;
  }
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif;
  font-size: 14px;
  line-height: 1.6;
  padding: 20px;
}

.idx-container {
  max-width: 800px;
  margin: 0 auto;
}

.idx-header {
  padding: 24px 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 24px;
}

.idx-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 4px;
}

.idx-meta {
  color: var(--fg-muted);
  font-size: 13px;
}

.idx-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.idx-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-radius: var(--radius);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  text-decoration: none;
  color: var(--fg);
  transition: background 0.15s, border-color 0.15s;
}

.idx-item:hover {
  background: var(--bg-surface);
  border-color: var(--accent);
}

.idx-filename {
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: 12px;
  color: var(--accent-secondary);
  min-width: 200px;
  flex-shrink: 0;
}

.idx-summary {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-muted);
  font-size: 13px;
}

.idx-date {
  font-size: 12px;
  color: var(--fg-muted);
  opacity: 0.7;
  flex-shrink: 0;
}

.idx-empty {
  text-align: center;
  color: var(--fg-muted);
  padding: 40px 0;
  font-size: 14px;
}

.idx-datasets {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.idx-tag {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(166, 227, 161, 0.12);
  color: var(--accent);
  border: 1px solid rgba(166, 227, 161, 0.25);
  font-family: "SF Mono", "Fira Code", monospace;
}

.idx-type {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  font-family: "SF Mono", "Fira Code", monospace;
  flex-shrink: 0;
}

.idx-type-analysis {
  background: rgba(137, 180, 250, 0.12);
  color: var(--accent-secondary);
  border: 1px solid rgba(137, 180, 250, 0.25);
}
`;