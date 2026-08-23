/**
 * Dashboard — 图表索引 Service
 *
 * 复用报告索引中的图表元数据：
 * 1. 从 manifest.json 提取图表列表
 * 2. 对旧报告兼容解析 HTML 中的 base64 图片
 * 3. 分页 + 筛选
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ChartSummary, PaginatedResponse } from "../types.js";

/** manifest.json 结构（简化） */
interface ChartManifest {
  id: string;
  title: string;
  generatedAt: string;
  dataset?: string;
  sourceReportId: string;
  sourceReportFile: string;
}

/**
 * 图表索引 Service
 */
export class ChartIndexService {
  private reportsDir: string;

  constructor(projectDir: string) {
    this.reportsDir = join(projectDir, "reports");
  }

  /**
   * 获取图表列表（分页 + 筛选）
   */
  list(params: {
    page?: number;
    size?: number;
    reportId?: string;
    dataset?: string;
  }): PaginatedResponse<ChartSummary> {
    const page = Math.max(1, params.page ?? 1);
    const size = Math.min(100, Math.max(1, params.size ?? 24));

    let charts = this.scanCharts();

    if (params.reportId) {
      charts = charts.filter((c) => c.sourceReportId === params.reportId);
    }
    if (params.dataset) {
      charts = charts.filter((c) =>
        c.dataset?.toLowerCase().includes(params.dataset!.toLowerCase())
      );
    }

    // 按生成时间倒序
    charts.sort((a, b) =>
      new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
    );

    const total = charts.length;
    const totalPages = Math.max(1, Math.ceil(total / size));
    const start = (page - 1) * size;
    const items = charts.slice(start, start + size);

    return { items, total, page, size, totalPages };
  }

  /**
   * 获取单个图表详情
   */
  get(chartId: string): ChartSummary | null {
    const charts = this.scanCharts();
    return charts.find((c) => c.id === chartId) ?? null;
  }

  // =========================================================================
  // Private
  // =========================================================================

  private scanCharts(): ChartSummary[] {
    if (!existsSync(this.reportsDir)) return [];

    // 尝试从 manifest 读取
    const manifestCharts = this.readManifestCharts();
    if (manifestCharts.length > 0) return manifestCharts;

    // Fallback: 扫描旧报告
    return this.scanLegacyCharts();
  }

  private readManifestCharts(): ChartSummary[] {
    const manifestPath = join(this.reportsDir, "manifest.json");
    if (!existsSync(manifestPath)) return [];

    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const manifest = JSON.parse(raw) as {
        reports?: Array<{
          id: string;
          file: string;
          charts?: ChartManifest[];
        }>;
      };

      if (!manifest.reports) return [];

      const charts: ChartSummary[] = [];
      for (const report of manifest.reports) {
        for (const chart of report.charts ?? []) {
          charts.push({
            id: chart.id,
            title: chart.title,
            generatedAt: chart.generatedAt,
            sourceReport: chart.sourceReportFile || report.file,
            sourceReportId: chart.sourceReportId || report.id,
            dataset: chart.dataset,
          });
        }
      }
      return charts;
    } catch {
      return [];
    }
  }

  private scanLegacyCharts(): ChartSummary[] {
    const charts: ChartSummary[] = [];
    if (!existsSync(this.reportsDir)) return charts;

    const files = readdirSync(this.reportsDir)
      .filter((f) => f.startsWith("session-") && f.endsWith(".html"))
      .sort()
      .reverse();

    for (const filename of files) {
      try {
        const content = readFileSync(join(this.reportsDir, filename), "utf-8");
        const reportId = filename.replace(".html", "");

        // 提取数据集
        const datasetsMatch = content.match(
          /<meta\s+name=["']datasets["']\s+content=["']([^"']*)["']/i
        );
        const datasets = datasetsMatch
          ? datasetsMatch[1].split(",").filter(Boolean)
          : [];

        // 提取时间
        const dateMatch = content.match(
          /<meta\s+name=["']generated-at["']\s+content=["']([^"']*)["']/i
        );
        const tsMatch = filename.match(/session-(\d+)\.html/);
        const generatedAt = dateMatch
          ? dateMatch[1]
          : tsMatch
            ? new Date(parseInt(tsMatch[1], 10)).toISOString()
            : "";

        // 提取图表
        const imgRegex =
          /<img\s+(?:[^>]*?\s)?src="(data:image\/png;base64,[^"]+)"[^>]*(?:alt=["']([^"']*)["'])?/gi;
        let match;
        let chartIdx = 0;
        while ((match = imgRegex.exec(content)) !== null) {
          const src = match[1];
          const alt = match[2] || "";
          // 跳过小图标
          if (src.length < 500) continue;

          charts.push({
            id: `chart_${reportId}_${chartIdx}`,
            title: alt || `图表 ${chartIdx + 1}`,
            generatedAt,
            sourceReport: filename,
            sourceReportId: reportId,
            dataset: datasets[0],
            // 不传输 base64（性能炸弹），前端按需从报告 HTML 中提取
            thumbnailUrl: undefined,
          });
          chartIdx++;
        }
      } catch {
        // 单文件解析失败不阻塞
      }
    }

    return charts;
  }
}
