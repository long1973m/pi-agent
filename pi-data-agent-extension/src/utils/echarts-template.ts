/**
 * ECharts 交互式图表 HTML 生成器
 *
 * 生成包含 ECharts CDN 的独立 HTML 文件，支持缩放、悬停、导出等交互。
 * 用于 visualize 工具的 interactive 模式。
 */

import { readFileSync } from "node:fs";

/** ECharts 图表类型映射 */
type EChartsType = "bar" | "line" | "scatter" | "pie";

/** 从 CSV 数据和图表配置生成 ECharts option 对象 */
function buildEChartsOption(
  rows: Record<string, unknown>[],
  columns: string[],
  chartType: string,
  config: {
    xColumn?: string;
    yColumn?: string;
    columns?: string[];
    title?: string;
  },
): Record<string, unknown> {
  const title = config.title || `${chartType.charAt(0).toUpperCase() + chartType.slice(1)} Chart`;
  const xCol = config.xColumn || columns[0];
  const yCol = config.yColumn || columns[1];

  if (chartType === "pie") {
    const labelCol = config.xColumn || columns[0];
    const valCol = config.yColumn || columns[1];
    const data = rows.map((r) => ({
      name: String(r[labelCol] ?? ""),
      value: Number(r[valCol] ?? 0),
    }));
    return {
      title: { text: title, left: "center" },
      tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
      legend: { orient: "vertical", left: "left", top: "middle" },
      series: [{
        type: "pie",
        radius: "60%",
        data,
        emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: "rgba(0,0,0,0.5)" } },
      }],
    };
  }

  if (chartType === "scatter") {
    return {
      title: { text: title, left: "center" },
      tooltip: { trigger: "item", formatter: (p: unknown) => {
        const item = p as { value: number[]; name: string };
        return `${xCol}: ${item.value[0]}<br/>${yCol}: ${item.value[1]}`;
      }},
      xAxis: { type: "value", name: xCol, scale: true },
      yAxis: { type: "value", name: yCol, scale: true },
      series: [{
        type: "scatter",
        symbolSize: 8,
        data: rows.map((r) => [Number(r[xCol]), Number(r[yCol])]),
      }],
      dataZoom: [
        { type: "inside", xAxisIndex: 0, filterMode: "none" },
        { type: "inside", yAxisIndex: 0, filterMode: "none" },
      ],
    };
  }

  // bar / line 共享结构
  const seriesCols = config.columns || (yCol ? [yCol] : columns.slice(1));
  const series = seriesCols.map((col) => {
    const data = rows.map((r) => {
      const v = r[col];
      const n = Number(v);
      return isNaN(n) ? null : n;
    });
    return {
      name: col,
      type: chartType as EChartsType,
      data,
      smooth: chartType === "line",
      label: { show: rows.length <= 20, position: "top" as const },
    };
  });

  return {
    title: { text: title, left: "center" },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: { data: seriesCols, top: 30 },
    grid: { left: "10%", right: "10%", bottom: "15%", top: 70, containLabel: true },
    toolbox: {
      feature: {
        dataZoom: { yAxisIndex: "none" },
        restore: {},
        saveAsImage: { title: "保存PNG", pixelRatio: 2 },
      },
      right: 20,
    },
    xAxis: {
      type: "category",
      name: xCol,
      data: rows.map((r) => String(r[xCol] ?? "")),
      axisLabel: { rotate: rows.length > 15 ? 45 : 0 },
    },
    yAxis: { type: "value", name: seriesCols.join(", ") },
    series,
    dataZoom: rows.length > 50 ? [
      { type: "slider", xAxisIndex: 0, start: 0, end: 100 },
      { type: "inside", xAxisIndex: 0, start: 0, end: 100 },
    ] : [],
  };
}

/** 生成完整的 ECharts HTML 文件内容 */
export function generateEChartsHtml(
  csvPath: string,
  outputPath: string,
  config: {
    chartType: string;
    xColumn?: string;
    yColumn?: string;
    columns?: string[];
    title?: string;
  },
): { success: boolean; outputPath?: string; error?: string; rowCount?: number } {
  // 读取 CSV 数据
  let rows: Record<string, unknown>[] = [];
  let columns: string[] = [];

  try {
    const csvContent = readFileSync(csvPath, "utf-8");
    const lines = csvContent.trim().split("\n");
    if (lines.length < 2) {
      return { success: false, error: "CSV data is empty or has no data rows" };
    }

    // 简单 CSV 解析（支持引号包裹）
    const parseLine = (line: string): string[] => {
      const result: string[] = [];
      let current = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (ch === "," && !inQuotes) {
          result.push(current);
          current = "";
        } else {
          current += ch;
        }
      }
      result.push(current);
      return result;
    };

    columns = parseLine(lines[0]);
    rows = lines.slice(1).map((line) => {
      const values = parseLine(line);
      const obj: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        obj[col] = values[i] ?? "";
      });
      return obj;
    });
  } catch (err) {
    return { success: false, error: `Failed to read CSV: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 限制交互式图表的最大行数（浏览器性能考虑）
  const MAX_INTERACTIVE_ROWS = 10000;
  if (rows.length > MAX_INTERACTIVE_ROWS) {
    rows = rows.slice(0, MAX_INTERACTIVE_ROWS);
  }

  // 构建 ECharts option
  const option = buildEChartsOption(rows, columns, config.chartType, config);

  // 生成 HTML
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(config.title || config.chartType + " Chart")}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #toolbar { padding: 8px 16px; background: #fff; border-bottom: 1px solid #e0e0e0; display: flex; justify-content: space-between; align-items: center; }
  #toolbar span { font-size: 14px; color: #666; }
  #chart { width: 100%; height: calc(100vh - 48px); }
  .badge { background: #e3f2fd; color: #1565c0; padding: 2px 8px; border-radius: 4px; font-size: 12px; margin-left: 8px; }
</style>
</head>
<body>
<div id="toolbar">
  <span>📊 ${escapeHtml(config.title || config.chartType + " Chart")} <span class="badge">Interactive</span></span>
  <span>${rows.length} rows · ${columns.length} columns</span>
</div>
<div id="chart"></div>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
<script>
  var chart = echarts.init(document.getElementById('chart'), null, { renderer: 'canvas' });
  var option = ${JSON.stringify(JSON.stringify(option))};
  var realOption = JSON.parse(option);
  // 修复 tooltip formatter 函数（JSON 序列化后变成字符串）
  ${config.chartType === "scatter" ? `realOption.tooltip.formatter = function(p) { return p.name + '<br/>' + '${config.xColumn || ""}' + ': ' + p.value[0] + '<br/>' + '${config.yColumn || ""}' + ': ' + p.value[1]; };` : ""}
  chart.setOption(realOption);
  window.addEventListener('resize', function() { chart.resize(); });
</script>
</body>
</html>`;

  // 写入 HTML 文件
  try {
    const { writeFileSync } = require("node:fs");
    writeFileSync(outputPath, html, "utf-8");
    return { success: true, outputPath, rowCount: rows.length };
  } catch (err) {
    return { success: false, error: `Failed to write HTML: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** HTML 转义 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
