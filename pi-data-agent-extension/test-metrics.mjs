import { createDashboardServer } from "./dist/dashboard/server.js";

const port = 9876;
const writeToken = "test-token";
const deps = {
  projectDir: "/tmp/test-project",
  cwd: "/tmp/test-project",
  engine: null,
};

try {
  const server = await createDashboardServer(port, writeToken, deps);
  console.log(`Server started on ${port}`);
  
  // Test /api/config
  const configRes = await fetch(`http://127.0.0.1:${port}/api/config`);
  const configData = await configRes.json();
  console.log("GET /api/config:", configRes.status, JSON.stringify(configData).slice(0, 200));
  
  // Test /api/metrics
  const metricsRes = await fetch(`http://127.0.0.1:${port}/api/metrics`);
  const metricsData = await metricsRes.json();
  console.log("GET /api/metrics:", metricsRes.status, JSON.stringify(metricsData).slice(0, 200));
  
  server.close();
  console.log("Done");
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
