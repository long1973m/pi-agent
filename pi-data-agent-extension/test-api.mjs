import express from "express";
import { join } from "node:path";

// 模拟 server.ts 的路由注册
import { createHealthRouter } from "./dist/dashboard/routes/health.js";
import { createReportsRouter } from "./dist/dashboard/routes/reports.js";
import { createDictionariesRouter } from "./dist/dashboard/routes/dictionaries.js";
import { createDatasetsRouter } from "./dist/dashboard/routes/datasets.js";
import { createChartsRouter } from "./dist/dashboard/routes/charts.js";
import { createSqlHistoryRouter } from "./dist/dashboard/routes/sql-history.js";
import { createMetricsRouter } from "./dist/dashboard/routes/metrics.js";
import { localOnly } from "./dist/dashboard/middleware/local-only.js";
import { originCheck } from "./dist/dashboard/middleware/origin-check.js";
import { writeTokenGuard, setWriteToken } from "./dist/dashboard/middleware/write-token.js";

const app = express();
setWriteToken("test-token");
app.use(localOnly);
app.use(originCheck);
app.use(express.json());
app.use(writeTokenGuard);
app.use(createHealthRouter("test-token"));
app.use(createMetricsRouter({ projectDir: process.cwd() }));

const http = await import("node:http");
const server = http.createServer(app);
server.listen(3998, "127.0.0.1", async () => {
    console.log("API test server on :3998");

    // Test 1: GET /api/metrics (no Origin, no write token needed)
    const r1 = await fetch("http://127.0.0.1:3998/api/metrics");
    console.log("GET /api/metrics status:", r1.status);
    const b1 = await r1.text();
    console.log("body:", b1.slice(0, 500));

    // Test 2: GET /api/config
    const r2 = await fetch("http://127.0.0.1:3998/api/config");
    console.log("\nGET /api/config status:", r2.status);
    const b2 = await r2.text();
    console.log("body:", b2);

    // Test 3: GET /api/health
    const r3 = await fetch("http://127.0.0.1:3998/api/health");
    console.log("\nGET /api/health status:", r3.status);
    const b3 = await r3.text();
    console.log("body:", b3);

    server.close();
});
