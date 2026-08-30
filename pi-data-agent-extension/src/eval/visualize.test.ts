/**
 * S1.1 visualize 工具验收测试
 *
 * 运行: npx tsx src/eval/visualize.test.ts
 *
 * 覆盖:
 * - V1.1: bar 图
 * - V1.2: line 图
 * - V1.3: scatter 图
 * - V1.4: histogram 图
 * - V1.5: pie 图
 * - V1.6: box 图
 * - V1.7: heatmap 图
 * - V1.8: 非 SELECT 拒绝
 * - V1.9: 无效列名拒绝
 * - V1.10: fallback（Python 失败时返回 CSV）
 */

import { loadConfig, toSecurityConfig } from "../config.js";
import { PersistenceManager } from "../persistence.js";
import { SecurityChecker } from "../security.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { createVisualizeTool } from "../tools/visualize.js";
import type { ToolContext } from "../tools/tool-context.js";
import { writeFileSync, mkdirSync, existsSync, statSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { defineScriptSuite } from "./helpers/vitest-suite.js";

const TEST_CWD = cwd();
const EVAL_DIR = join(TEST_CWD, ".pi-data-agent", "eval");

/** 创建 Iris 数据集 */
function ensureIrisDataset(): string {
  mkdirSync(EVAL_DIR, { recursive: true });
  const irisCsv = `sepal_length,sepal_width,petal_length,petal_width,species
5.1,3.5,1.4,0.2,setosa
4.9,3.0,1.4,0.2,setosa
4.7,3.2,1.3,0.2,setosa
4.6,3.1,1.5,0.2,setosa
5.0,3.6,1.4,0.2,setosa
5.4,3.9,1.7,0.4,setosa
4.6,3.4,1.4,0.3,setosa
5.0,3.4,1.5,0.2,setosa
4.4,2.9,1.4,0.2,setosa
4.9,3.1,1.5,0.1,setosa
7.0,3.2,4.7,1.4,versicolor
6.4,3.2,4.5,1.5,versicolor
6.9,3.1,4.9,1.5,versicolor
5.5,2.3,4.0,1.3,versicolor
6.5,2.8,4.6,1.5,versicolor
5.7,2.8,4.5,1.3,versicolor
6.3,3.3,4.7,1.6,versicolor
4.9,2.4,3.3,1.0,versicolor
6.6,2.9,4.6,1.3,versicolor
5.2,2.7,3.9,1.4,versicolor
6.3,3.3,6.0,2.5,virginica
5.8,2.7,5.1,1.9,virginica
7.1,3.0,5.9,2.1,virginica
6.3,2.9,5.6,1.8,virginica
6.5,3.0,5.8,2.2,virginica
7.6,3.0,6.6,2.1,virginica
4.9,2.5,4.5,1.7,virginica
7.3,2.9,6.3,1.8,virginica
6.7,2.5,5.8,1.8,virginica
6.3,2.8,5.1,1.5,virginica
`;
  const irisPath = join(EVAL_DIR, "iris.csv");
  writeFileSync(irisPath, irisCsv);
  return irisPath;
}

/** 模拟 ExtensionContext */
const mockCtx = {
  ui: null,
  cwd: TEST_CWD,
  sessionManager: { getBranch: () => [], appendEntry: () => {} },
} as any;

async function runVisualizeTests(): Promise<void> {
  console.log("=== S1.1 Visualize Tool Acceptance Tests ===\n");
  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, detail?: string): void {
    if (condition) {
      console.log(`  ✅ ${name}`);
      passed++;
    } else {
      console.log(`  ❌ ${name}${detail ? `: ${detail}` : ""}`);
      failed++;
    }
  }

  // Setup
  const irisPath = ensureIrisDataset();
  const config = loadConfig();
  const persistence = new PersistenceManager(config.globalConfigDir, config.projectConfigDir);
  persistence.saveDataDictionary([], "project");
  persistence.saveQueryMemory({ maxEntries: 5, entries: [] }, "project");

  const security = new SecurityChecker(toSecurityConfig(config));
  const engine = new DuckDBEngine({
    dbPath: config.dbPath,
    previewLimit: config.previewLimit,
    outputDir: config.outputDir,
  });
  await engine.init();

  // 加载 iris
  const loadSql = `CREATE OR REPLACE TABLE iris AS SELECT * FROM read_csv_auto('${irisPath}');`;
  await engine.exec(loadSql);

  // 构建工具上下文
  const toolContext: ToolContext = {
    engine,
    security,
    persistence,
    cwd: config.cwd,
    config,
    dataDictionary: {} as any,
    queryMemory: {} as any,
  };

  const getRuntime = () => toolContext;
  const visualizeTool = createVisualizeTool({ getRuntime });

  // ========================================================================
  // V1.1 bar 图
  // ========================================================================
  console.log("\n[bar chart]");
  const barResult = await visualizeTool.execute(
    "test-bar", {
      sql: "SELECT species, COUNT(*) AS cnt FROM iris GROUP BY species ORDER BY species",
      chart_type: "bar",
      x_column: "species",
      y_column: "cnt",
      title: "Species Count (Bar)",
    },
    undefined, undefined, mockCtx
  );
  const barDetails = barResult.details as Record<string, any> | undefined;
  const barPngPath = barDetails?.pngPath as string | undefined;
  assert("bar: success flag", barDetails?.success === true, JSON.stringify(barDetails));
  assert("bar: PNG exists", barPngPath ? existsSync(barPngPath) : false, barPngPath);
  assert("bar: PNG size > 0", barPngPath ? (statSync(barPngPath).size > 0) : false);

  // ========================================================================
  // V1.2 line 图
  // ========================================================================
  console.log("\n[line chart]");
  const lineResult = await visualizeTool.execute(
    "test-line", {
      sql: "SELECT species, COUNT(*) AS cnt FROM iris GROUP BY species ORDER BY species",
      chart_type: "line",
      x_column: "species",
      y_column: "cnt",
      title: "Species Count (Line)",
    },
    undefined, undefined, mockCtx
  );
  const lineDetails = lineResult.details as Record<string, any> | undefined;
  const linePngPath = lineDetails?.pngPath as string | undefined;
  assert("line: success flag", lineDetails?.success === true);
  assert("line: PNG exists", linePngPath ? existsSync(linePngPath) : false);
  assert("line: PNG size > 0", linePngPath ? (statSync(linePngPath).size > 0) : false);

  // ========================================================================
  // V1.3 scatter 图
  // ========================================================================
  console.log("\n[scatter chart]");
  const scatterResult = await visualizeTool.execute(
    "test-scatter", {
      sql: "SELECT sepal_length, sepal_width, species FROM iris",
      chart_type: "scatter",
      x_column: "sepal_length",
      y_column: "sepal_width",
      title: "Sepal Length vs Width",
      options: { colorColumn: "species" },
    },
    undefined, undefined, mockCtx
  );
  const scatterDetails = scatterResult.details as Record<string, any> | undefined;
  const scatterPngPath = scatterDetails?.pngPath as string | undefined;
  assert("scatter: success flag", scatterDetails?.success === true);
  assert("scatter: PNG exists", scatterPngPath ? existsSync(scatterPngPath) : false);
  assert("scatter: PNG size > 0", scatterPngPath ? (statSync(scatterPngPath).size > 0) : false);

  // ========================================================================
  // V1.4 histogram 图
  // ========================================================================
  console.log("\n[histogram chart]");
  const histResult = await visualizeTool.execute(
    "test-histogram", {
      sql: "SELECT sepal_length FROM iris",
      chart_type: "histogram",
      columns: ["sepal_length"],
      title: "Sepal Length Distribution",
      options: { bins: 10 },
    },
    undefined, undefined, mockCtx
  );
  const histDetails = histResult.details as Record<string, any> | undefined;
  const histPngPath = histDetails?.pngPath as string | undefined;
  assert("histogram: success flag", histDetails?.success === true);
  assert("histogram: PNG exists", histPngPath ? existsSync(histPngPath) : false);
  assert("histogram: PNG size > 0", histPngPath ? (statSync(histPngPath).size > 0) : false);

  // ========================================================================
  // V1.5 pie 图
  // ========================================================================
  console.log("\n[pie chart]");
  const pieResult = await visualizeTool.execute(
    "test-pie", {
      sql: "SELECT species, COUNT(*) AS cnt FROM iris GROUP BY species",
      chart_type: "pie",
      x_column: "species",
      y_column: "cnt",
      title: "Species Distribution",
    },
    undefined, undefined, mockCtx
  );
  const pieDetails = pieResult.details as Record<string, any> | undefined;
  const piePngPath = pieDetails?.pngPath as string | undefined;
  assert("pie: success flag", pieDetails?.success === true);
  assert("pie: PNG exists", piePngPath ? existsSync(piePngPath) : false);
  assert("pie: PNG size > 0", piePngPath ? (statSync(piePngPath).size > 0) : false);

  // ========================================================================
  // V1.6 box 图
  // ========================================================================
  console.log("\n[box chart]");
  const boxResult = await visualizeTool.execute(
    "test-box", {
      sql: "SELECT sepal_length, sepal_width, petal_length, petal_width FROM iris",
      chart_type: "box",
      columns: ["sepal_length", "sepal_width", "petal_length"],
      title: "Measurement Box Plot",
    },
    undefined, undefined, mockCtx
  );
  const boxDetails = boxResult.details as Record<string, any> | undefined;
  const boxPngPath = boxDetails?.pngPath as string | undefined;
  assert("box: success flag", boxDetails?.success === true);
  assert("box: PNG exists", boxPngPath ? existsSync(boxPngPath) : false);
  assert("box: PNG size > 0", boxPngPath ? (statSync(boxPngPath).size > 0) : false);

  // ========================================================================
  // V1.7 heatmap 图
  // ========================================================================
  console.log("\n[heatmap chart]");
  const heatmapResult = await visualizeTool.execute(
    "test-heatmap", {
      sql: "SELECT sepal_length, sepal_width, petal_length, petal_width FROM iris",
      chart_type: "heatmap",
      columns: ["sepal_length", "sepal_width", "petal_length", "petal_width"],
      title: "Correlation Heatmap",
    },
    undefined, undefined, mockCtx
  );
  const heatmapDetails = heatmapResult.details as Record<string, any> | undefined;
  const heatmapPngPath = heatmapDetails?.pngPath as string | undefined;
  assert("heatmap: success flag", heatmapDetails?.success === true);
  assert("heatmap: PNG exists", heatmapPngPath ? existsSync(heatmapPngPath) : false);
  assert("heatmap: PNG size > 0", heatmapPngPath ? (statSync(heatmapPngPath).size > 0) : false);

  // ========================================================================
  // V1.8 非 SELECT 拒绝
  // ========================================================================
  console.log("\n[security: non-SELECT rejected]");
  const nonSelectResult = await visualizeTool.execute(
    "test-nonselect", {
      sql: "DROP TABLE iris",
      chart_type: "bar",
      x_column: "species",
    },
    undefined, undefined, mockCtx
  );
  const nonSelectDetails = nonSelectResult.details as Record<string, any> | undefined;
  assert("non-SELECT: blocked", nonSelectDetails?.error === "non_select_sql" || nonSelectDetails?.blocked === true);

  // ========================================================================
  // V1.9 无效列名拒绝
  // ========================================================================
  console.log("\n[validation: invalid column rejected]");
  const invalidColResult = await visualizeTool.execute(
    "test-invalid-col", {
      sql: "SELECT species, COUNT(*) AS cnt FROM iris GROUP BY species",
      chart_type: "bar",
      x_column: "nonexistent_column",
    },
    undefined, undefined, mockCtx
  );
  const invalidColDetails = invalidColResult.details as Record<string, any> | undefined;
  assert("invalid column: rejected", invalidColDetails?.error === "invalid_x_column");

  // ========================================================================
  // V1.10 fallback（错误 chart_type）
  // ========================================================================
  console.log("\n[fallback: invalid chart type]");
  const fallbackResult = await visualizeTool.execute(
    "test-fallback", {
      sql: "SELECT species, COUNT(*) AS cnt FROM iris GROUP BY species",
      chart_type: "nonexistent_chart",
      x_column: "species",
      y_column: "cnt",
    },
    undefined, undefined, mockCtx
  );
  const fallbackDetails = fallbackResult.details as Record<string, any> | undefined;
  assert("fallback: success=false", fallbackDetails?.success === false);
  assert("fallback: csvPath present", typeof fallbackDetails?.csvPath === "string");
  assert("fallback: error present", typeof fallbackDetails?.error === "string");

  // Cleanup
  await engine.close();

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    throw new Error(`${failed} assertion(s) failed`);
  }
}

defineScriptSuite("visualize", runVisualizeTests);
