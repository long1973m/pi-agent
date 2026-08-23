/**
 * 阶段1 集成验证 (I1.1)
 *
 * visualize 生成 PNG → show_image 展示
 * 运行: npx tsx src/eval/integration-phase1.test.ts
 */

import { loadConfig, toSecurityConfig } from "../config.js";
import { PersistenceManager } from "../persistence.js";
import { SecurityChecker } from "../security.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { createVisualizeTool } from "../tools/visualize.js";
import { createShowImageTool } from "../tools/show-image.js";
import { createLoadDataTool } from "../tools/load-data.js";
import type { ToolContext } from "../tools/tool-context.js";
import { writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

const TEST_CWD = cwd();
const EVAL_DIR = join(TEST_CWD, ".pi-data-agent", "eval");

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

const mockCtx = {
  ui: null,
  cwd: TEST_CWD,
  sessionManager: { getBranch: () => [], appendEntry: () => {} },
} as any;

async function runIntegrationTests(): Promise<void> {
  console.log("=== Phase 1 Integration Test (I1.1) ===\n");
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

  const loadTool = createLoadDataTool({ getRuntime });
  const visualizeTool = createVisualizeTool({ getRuntime });
  const showImageTool = createShowImageTool({ getRuntime });

  // Step 1: load iris
  console.log("[Step 1] load_data iris.csv");
  const loadResult = await loadTool.execute("test", { file_path: irisPath }, undefined, undefined, mockCtx);
  const loadDetails = loadResult.details as Record<string, any> | undefined;
  assert("load_data success", loadDetails?.tableName === "iris");

  // Step 2: visualize → bar chart PNG
  console.log("\n[Step 2] visualize → bar chart PNG");
  const vizResult = await visualizeTool.execute(
    "test-viz",
    {
      sql: "SELECT species, COUNT(*) AS cnt FROM iris GROUP BY species ORDER BY species",
      chart_type: "bar",
      x_column: "species",
      y_column: "cnt",
      title: "Iris Species Count",
    },
    undefined, undefined, mockCtx
  );
  const vizDetails = vizResult.details as Record<string, any> | undefined;
  assert("visualize success", vizDetails?.success === true, JSON.stringify(vizDetails));
  const pngPath = vizDetails?.pngPath as string | undefined;
  assert("PNG path returned", !!pngPath);
  assert("PNG file exists", pngPath ? existsSync(pngPath) : false);
  assert("PNG size > 0", pngPath ? (statSync(pngPath).size > 0) : false);

  // Step 3: show_image → display PNG
  console.log("\n[Step 3] show_image → display PNG");
  const showResult = await showImageTool.execute(
    "test-show",
    { file_path: pngPath! },
    undefined, undefined, mockCtx
  );
  const showDetails = showResult.details as Record<string, any> | undefined;
  assert("show_image success", showDetails?.success === true);
  const hasImageContent = showResult.content.some((c: any) => c.type === "image");
  assert("show_image has image content", hasImageContent);
  assert("show_image has text description", showResult.content.some((c: any) => c.type === "text"));
  assert("show_image mimeType is image/png", showResult.content.some((c: any) => c.type === "image" && c.mimeType === "image/png"));

  // Cleanup
  await engine.close();
  if (pngPath && existsSync(pngPath)) unlinkSync(pngPath);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runIntegrationTests().catch((err) => {
  console.error("Integration test error:", err);
  process.exit(1);
});
