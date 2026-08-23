/**
 * Dashboard — 报告索引 Service
 *
 * 复用 build-index.ts 的扫描逻辑，增加：
 * 1. manifest.json 优先读取（新报告）
 * 2. 旧报告 meta 解析 fallback
 * 3. API 层分页 + 筛选
 * 4. 双报告类型支持（session / analysis）
 * 5. 持久化 manifest 原子写入
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join, basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ReportSummary,
  ReportType,
  AnalysisReportMode,
  ChartSummary,
  PaginatedResponse,
} from "../types.js";

/** 新增报告时的输入数据 */
export interface AddReportInput {
  id: string;
  type: ReportType;
  title: string;
  summary: string;
  createdAt?: string;
  file: string;
  datasets: string[];
  charts: Array<{
    id: string;
    title: string;
    generatedAt: string;
    dataset?: string;
    thumbnailUrl?: string;
  }>;
  reportMode?: AnalysisReportMode;
  sourceSessionId?: string;
  sourceSessionReportId?: string;
  evidenceCoverage?: number;
  /** 证据包 JSON 路径（仅 analysis 报告） */
  evidencePath?: string;
  analysisReportIds?: string[];
}

/** manifest.json 中单条报告记录 */
interface ManifestReport {
  id: string;
  type?: ReportType;
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
    thumbnailUrl?: string;
  }>;
  reportMode?: AnalysisReportMode;
  sourceSessionId?: string;
  sourceSessionReportId?: string;
  evidenceCoverage?: number;
  /** 证据包 JSON 路径（仅 analysis 报告） */
  evidencePath?: string;
  analysisReportIds?: string[];
}

/** manifest.json 结构 */
interface ReportManifest {
  revision: number;
  reports: ManifestReport[];
}

/**
 * 报告索引 Service
 */
export class ReportIndexService {
  private reportsDir: string;

  constructor(projectDir: string) {
    this.reportsDir = join(projectDir, "reports");
  }

  /**
   * 获取报告列表（分页 + 筛选）
   */
  list(params: {
    page?: number;
    size?: number;
    query?: string;
    dataset?: string;
  }): PaginatedResponse<ReportSummary> {
    const page = Math.max(1, params.page ?? 1);
    const size = Math.min(100, Math.max(1, params.size ?? 20));
    const query = (params.query ?? "").toLowerCase().trim();
    const dataset = (params.dataset ?? "").toLowerCase().trim();

    let reports = this.scanReports();

    // 筛选
    if (query) {
      reports = reports.filter(
        (r) =>
          r.title.toLowerCase().includes(query) ||
          r.summary.toLowerCase().includes(query)
      );
    }
    if (dataset) {
      reports = reports.filter((r) =>
        r.datasets.some((d) => d.toLowerCase().includes(dataset))
      );
    }

    // 分页
    const total = reports.length;
    const totalPages = Math.max(1, Math.ceil(total / size));
    const start = (page - 1) * size;
    const items = reports.slice(start, start + size);

    return { items, total, page, size, totalPages };
  }

  /**
   * 获取单个报告详情
   */
  get(reportId: string): ReportSummary | null {
    const reports = this.scanReports();
    return reports.find((r) => r.id === reportId) ?? null;
  }

  /**
   * 读取报告 HTML 内容（用于 iframe 展示）
   */
  getContent(reportId: string): string | null {
    const report = this.get(reportId);
    if (!report) return null;

    const filePath = join(this.reportsDir, report.file);
    if (!existsSync(filePath)) return null;

    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * 向 manifest 添加一条报告记录（原子写入）
   *
   * - 读取当前 manifest，获取 revision
   * - session 报告：同 id 则更新，否则追加
   * - analysis 报告：总是追加（每次分析都是独立产物，不覆盖）
   * - 递增 revision，原子写入
   *
   * @returns 写入后的 revision
   */
  addReport(report: AddReportInput): number {
    const manifestPath = join(this.reportsDir, "manifest.json");

    // 确保目录存在
    try {
      mkdirSync(dirname(manifestPath), { recursive: true });
    } catch {
      // 忽略
    }

    // 如果 analysis 报告且 charts 缺少 thumbnailUrl，尝试从 HTML 提取
    if (
      report.type === "analysis" &&
      report.file &&
      report.charts.length > 0 &&
      !report.charts.some((c) => c.thumbnailUrl)
    ) {
      const filePath = join(this.reportsDir, report.file);
      if (existsSync(filePath)) {
        try {
          const htmlContent = readFileSync(filePath, "utf-8");
          const thumbnails = this.extractChartThumbnails(htmlContent);
          report.charts = report.charts.map((c, i) => ({
            ...c,
            thumbnailUrl: c.thumbnailUrl || thumbnails[i]?.thumbnailBase64,
          }));
        } catch {
          // 忽略提取失败
        }
      }
    }

    // 读取现有 manifest
    const manifest = this.readManifest() ?? { revision: 0, reports: [] };

    // 同 id 更新，否则追加
    const idx = manifest.reports.findIndex((r) => r.id === report.id);
    const entry: ManifestReport = {
      id: report.id,
      type: report.type,
      title: report.title,
      summary: report.summary,
      createdAt: report.createdAt ?? new Date().toISOString(),
      file: report.file,
      datasets: report.datasets,
      charts: report.charts,
      reportMode: report.reportMode,
      sourceSessionId: report.sourceSessionId,
      sourceSessionReportId: report.sourceSessionReportId,
      evidenceCoverage: report.evidenceCoverage,
      evidencePath: report.evidencePath,
      analysisReportIds: report.analysisReportIds,
    };

    if (idx >= 0 && report.type !== "analysis") {
      // session 报告：同 id 更新（session 报告可能重新生成）
      manifest.reports[idx] = entry;
    } else {
      // analysis 报告：总是追加（即使 id 相同也作为新记录，因为每次分析都是独立产物）
      // 或者 session 报告的新增
      manifest.reports.push(entry);
    }

    const newRevision = manifest.revision + 1;
    const newManifest: ReportManifest = {
      revision: newRevision,
      reports: manifest.reports,
    };

    this.atomicWriteManifest(manifestPath, newManifest);

    return newRevision;
  }

  /**
   * 获取指定 session 的所有报告（session 本身 + 关联的 analysis）
   */
  getBySessionId(sessionId: string): ReportSummary[] {
    const reports = this.scanReports();

    return reports.filter((r) => {
      // session 报告本身
      if (r.id === sessionId) return true;
      // analysis 报告来源此 session
      if (r.sourceSessionId === sessionId) return true;
      // session 报告的 analysisReportIds 中包含此 id 的不会出现（sessionId 是 session 的 id）
      return false;
    });
  }

  /**
   * 按类型筛选报告列表
   */
  listByType(type: ReportType): ReportSummary[] {
    const reports = this.scanReports();
    return reports.filter((r) => r.type === type);
  }

  // =========================================================================
  // Private
  // =========================================================================

  private scanReports(): ReportSummary[] {
    if (!existsSync(this.reportsDir)) return [];

    // 优先读取 manifest
    const manifest = this.readManifest();
    if (manifest && manifest.reports.length > 0) {
      return manifest.reports.map((r) => this.toReportSummary(r));
    }

    // Fallback: 扫描文件名 + 解析 meta
    return this.scanLegacyReports();
  }

  private readManifest(): ReportManifest | null {
    const manifestPath = join(this.reportsDir, "manifest.json");
    if (!existsSync(manifestPath)) return null;
    try {
      return JSON.parse(readFileSync(manifestPath, "utf-8")) as ReportManifest;
    } catch {
      return null;
    }
  }

  private scanLegacyReports(): ReportSummary[] {
    const files = readdirSync(this.reportsDir).filter(
      (f) =>
        (f.startsWith("session-") || f.startsWith("analysis-")) &&
        f.endsWith(".html")
    );

    return files
      .map((filename) => this.parseLegacyReport(filename))
      .sort((a, b) => {
        const ta = new Date(a.createdAt).getTime();
        const tb = new Date(b.createdAt).getTime();
        return tb - ta; // 倒序
      });
  }

  private parseLegacyReport(filename: string): ReportSummary {
    const id = filename.replace(".html", "");
    let title = id;
    let summary = "无摘要";
    let createdAt = "";
    const datasets: string[] = [];
    const charts: ChartSummary[] = [];

    // 根据文件名前缀推断 type
    const type: ReportType = filename.startsWith("analysis-")
      ? "analysis"
      : "session";

    // 尝试从文件名提取 session 关联信息
    let sourceSessionId: string | undefined;
    let sourceSessionReportId: string | undefined;
    let evidencePath: string | undefined;
    if (type === "analysis") {
      // analysis-<sessionReportId>-<timestamp>.html 或 analysis-<timestamp>.html
      const analysisMatch = filename.match(
        /^analysis-(session-\d+)-(\d+)\.html$/
      );
      if (analysisMatch) {
        sourceSessionReportId = analysisMatch[1];
        // 从 sourceSessionReportId 提取 sessionId（去掉 -<timestamp>）
        sourceSessionId = analysisMatch[1].replace(/-\d+$/, "");
      }
    }

    try {
      const content = readFileSync(join(this.reportsDir, filename), "utf-8");

      // 提取 title
      const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
      if (titleMatch) title = titleMatch[1].trim();

      // 提取 summary meta
      const summaryMatch = content.match(
        /<meta\s+name=["']summary["']\s+content=["']([^"']*)["']/i
      );
      if (summaryMatch) summary = summaryMatch[1].trim();

      // 提取 datasets meta
      const datasetsMatch = content.match(
        /<meta\s+name=["']datasets["']\s+content=["']([^"']*)["']/i
      );
      if (datasetsMatch) {
        datasets.push(...datasetsMatch[1].split(",").filter(Boolean));
      }

      // 提取生成时间
      const dateMatch = content.match(
        /<meta\s+name=["']generated-at["']\s+content=["']([^"']*)["']/i
      );
      if (dateMatch) {
        createdAt = dateMatch[1];
      } else {
        // 从文件名提取时间戳
        const tsMatch = filename.match(/(\d+)\.html$/);
        createdAt = tsMatch
          ? new Date(parseInt(tsMatch[1], 10)).toISOString()
          : new Date().toISOString();
      }

      // 提取图表（base64 图片）
      const imgRegex =
        /<img\s+src="(data:image\/[^"]+|[^"]*\.(?:png|jpg|jpeg|svg))"[^>]*(?:alt=["']([^"']*)["'])?/gi;
      let imgMatch;
      while ((imgMatch = imgRegex.exec(content)) !== null) {
        const src = imgMatch[1];
        const alt = imgMatch[2] || "";
        // 跳过小图标
        if (
          alt.includes("emoji") ||
          (src.startsWith("data:") && src.length < 100)
        )
          continue;
        charts.push({
          id: `chart_${charts.length}_${id}`,
          title: alt || `图表 ${charts.length + 1}`,
          generatedAt: createdAt,
          sourceReport: filename,
          sourceReportId: id,
          dataset: datasets[0],
          thumbnailUrl: src.startsWith("data:") ? src : undefined,
        });
      }

      // 尝试从 meta 提取 analysis 专属字段
      if (type === "analysis") {
        const modeMatch = content.match(
          /<meta\s+name=["']report-mode["']\s+content=["']([^"']*)["']/i
        );
        const coverageMatch = content.match(
          /<meta\s+name=["']evidence-coverage["']\s+content=["']([^"']*)["']/i
        );
        const evidencePathMatch = content.match(
          /<meta\s+name=["']evidence-path["']\s+content=["']([^"']*)["']/i
        );
        const srcSessionMatch = content.match(
          /<meta\s+name=["']source-session-id["']\s+content=["']([^"']*)["']/i
        );
        const srcReportMatch = content.match(
          /<meta\s+name=["']source-session-report-id["']\s+content=["']([^"']*)["']/i
        );
        if (srcSessionMatch) sourceSessionId = srcSessionMatch[1].trim();
        if (srcReportMatch) sourceSessionReportId = srcReportMatch[1].trim();
        if (evidencePathMatch) {
          evidencePath = evidencePathMatch[1].trim();
        }
      }
    } catch {
      // 解析失败不阻塞
    }

    const result: ReportSummary = {
      id,
      title,
      summary,
      createdAt,
      file: filename,
      datasets,
      charts,
      type,
    };

    if (type === "analysis") {
      if (sourceSessionId) result.sourceSessionId = sourceSessionId;
      if (sourceSessionReportId)
        result.sourceSessionReportId = sourceSessionReportId;
      if (evidencePath) result.evidencePath = evidencePath;
    }

    return result;
  }

  private toReportSummary(
    manifestReport: ManifestReport
  ): ReportSummary {
    const result: ReportSummary = {
      id: manifestReport.id,
      title: manifestReport.title,
      summary: manifestReport.summary,
      createdAt: manifestReport.createdAt,
      file: manifestReport.file,
      datasets: manifestReport.datasets,
      charts: (manifestReport.charts ?? []).map((c) => ({
        id: c.id,
        title: c.title,
        generatedAt: c.generatedAt,
        sourceReport: manifestReport.file,
        sourceReportId: manifestReport.id,
        dataset: c.dataset,
        thumbnailUrl: c.thumbnailUrl,
      })),
    };

    // 映射可选字段
    if (manifestReport.type) result.type = manifestReport.type;
    if (manifestReport.reportMode) result.reportMode = manifestReport.reportMode;
    if (manifestReport.sourceSessionId)
      result.sourceSessionId = manifestReport.sourceSessionId;
    if (manifestReport.sourceSessionReportId)
      result.sourceSessionReportId = manifestReport.sourceSessionReportId;
    if (manifestReport.evidenceCoverage !== undefined)
      result.evidenceCoverage = manifestReport.evidenceCoverage;
    if (manifestReport.evidencePath) result.evidencePath = manifestReport.evidencePath;
    if (manifestReport.analysisReportIds)
      result.analysisReportIds = manifestReport.analysisReportIds;

    return result;
  }

  /**
   * 从 HTML 内容中提取图表 base64 缩略图
   */
  private extractChartThumbnails(
    htmlContent: string
  ): Array<{ chartId: string; thumbnailBase64: string }> {
    const thumbnails: Array<{ chartId: string; thumbnailBase64: string }> = [];
    const imgRegex = /<img[^>]+src="(data:image\/[^;]+;base64,[^"]+)"/g;
    let match: RegExpExecArray | null;
    let idx = 0;
    while ((match = imgRegex.exec(htmlContent)) !== null) {
      thumbnails.push({
        chartId: `chart-${idx++}`,
        thumbnailBase64: match[1],
      });
    }
    return thumbnails;
  }

  /**
   * 原子写入 manifest.json
   *
   * 采用与 AtomicStore 相同的模式：tmp → validate → rename
   * 不使用 AtomicStore 实例，因为 manifest 格式为 {revision, reports}
   * 而非 AtomicStore 要求的 RevisionedData<T> 包装
   */
  private atomicWriteManifest(
    filePath: string,
    manifest: ReportManifest
  ): void {
    const content = JSON.stringify(manifest, null, 2);
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
      throw new Error("[ReportIndexService] manifest.json 写入校验失败");
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
        `[ReportIndexService] manifest.json 原子替换失败: ${err instanceof Error ? err.message : String(err)}`
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

    console.log(
      `[ReportIndexService] Manifest written (revision: ${manifest.revision}, ${manifest.reports.length} reports)`
    );
  }
}