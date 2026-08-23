/**
 * 视觉验收用临时引导:独立启动 Dashboard(不依赖 pi TUI),带一张样例表。
 * 用完即删,不属于产品代码。
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDashboardServer } from "./src/dashboard/server.js";
import { loadOrCreateWriteToken } from "./src/dashboard/lifecycle.js";
import { DuckDBEngine } from "./src/engine/duckdb.js";
import { loadConfig } from "./src/config.js";

const dir = mkdtempSync(join(tmpdir(), "pi-dash-preview-"));
const dataDir = join(dir, ".pi-data-agent");
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(dataDir, "uploads"), { recursive: true });
mkdirSync(join(dataDir, "output"), { recursive: true });

const csv = [
  "order_id,category,amount,order_time",
  "O1,app,10.5,2024-06-01 00:00:00",
  "O2,web,20.0,2024-06-02 00:00:00",
  "O3,app,,2024-06-03 00:00:00",
  "O4,web,15.5,2024-06-04 00:00:00",
  "O5,app,12.0,2024-06-05 00:00:00",
  "O6,web,,2024-06-06 00:00:00",
  "O7,app,18.2,2024-06-07 00:00:00",
].join("\n");
const csvPath = join(dir, "orders.csv");
writeFileSync(csvPath, csv);

const config = loadConfig({
  cwd: dir,
  allowedPaths: [dir],
  dbPath: join(dataDir, "session.duckdb"),
  projectConfigDir: dataDir,
  outputDir: join(dataDir, "output"),
  uploadsDir: join(dataDir, "uploads"),
});

const engine = new DuckDBEngine({
  dbPath: config.dbPath,
  previewLimit: config.previewLimit,
  outputDir: config.outputDir,
});
await engine.init();
await engine.exec(`CREATE TABLE orders AS SELECT * FROM read_csv_auto('${csvPath}')`);

const token = loadOrCreateWriteToken(dataDir);
const server = await createDashboardServer(4188, token, {
  projectDir: dataDir,
  cwd: dir,
  engine,
  uploadsDir: config.uploadsDir,
});
console.log("PREVIEW_READY http://127.0.0.1:4188");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
