/**
 * Pi Data Agent Dashboard — 主 Server
 *
 * 职责：
 * 1. 创建 Express 应用并装配所有中间件和路由
 * 2. 提供静态资源服务
 * 3. 挂载所有 API 路由
 * 4. 导出 createApp 供 lifecycle.ts 调用
 *
 * 路由挂载顺序：
 * - 中间件：local-only → origin-check → upload 专用 json parser(70MB) → 413 错误码转换 → 全局 json parser(256kb) → write-token
 * - 路由：health → upload → reports → dictionaries → datasets → charts → sql-history → metrics → table-cards
 * - 静态资源：/ → dashboard 首页
 * - 错误处理：errorHandler（最后）
 */

import express from "express";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { join } from "node:path";

// 中间件
import { localOnly } from "./middleware/local-only.js";
import { createHostCheck, dashboardAllowedHosts } from "./middleware/host-check.js";
import { originCheck } from "./middleware/origin-check.js";
import { writeTokenGuard, setWriteToken } from "./middleware/write-token.js";
import { errorHandler } from "./middleware/error-handler.js";
import { rateLimiter } from "./middleware/rate-limiter.js";
import { securityHeaders } from "./middleware/security-headers.js";

// 配置
import { BODY_SIZE_LIMIT, UPLOAD_BODY_SIZE_LIMIT } from "./config.js";

// 路由
import { createHealthRouter } from "./routes/health.js";
import { createReportsRouter } from "./routes/reports.js";
import { createDictionariesRouter } from "./routes/dictionaries.js";
import { createDatasetsRouter } from "./routes/datasets.js";
import { createChartsRouter } from "./routes/charts.js";
import { createSqlHistoryRouter } from "./routes/sql-history.js";
import { createMetricsRouter } from "./routes/metrics.js";
import { createUploadRouter } from "./routes/upload.js";
import { createTableCardsRouter } from "./routes/table-cards.js";
import { createConnectionsRouter } from "./routes/connections.js";

import type { DuckDBEngine } from "../engine/duckdb.js";
import type { DataDictionaryManager } from "../hooks/data-dictionary.js";
import type { QueryMemoryManager } from "../hooks/query-memory.js";
import type { AppConfig } from "../config.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("dashboard");

/**
 * Dashboard Server 依赖
 * 由 index.ts 在注册 /dashboard 命令时注入
 */
export interface DashboardDependencies {
  /** 项目数据目录（.pi-data-agent/） */
  projectDir: string;
  /** 项目根目录（cwd） */
  cwd: string;
  /** DuckDB 引擎（只读连接，可为 null） */
  engine: DuckDBEngine | null;
  /** 数据字典管理器（可选，用于 AI 推断和审核） */
  dictionaryManager?: DataDictionaryManager;
  /** 查询记忆管理器（可选，v0.10 A-3/A-5：表卡片起草召回 / SQL 历史固定） */
  queryMemory?: QueryMemoryManager;
  /** LLM 调用函数（可选，用于 AI 推断） */
  callLLM?: (prompt: string, systemPrompt?: string) => Promise<string>;
  /** 上传目录路径 */
  uploadsDir: string;
}

/**
 * 创建 Dashboard HTTP Server
 *
 * @param port - 监听端口
 * @param writeToken - 写令牌
 * @param deps - 外部依赖
 * @returns Promise<Server>
 */
export async function createDashboardServer(
  port: number,
  writeToken: string,
  deps: DashboardDependencies,
): Promise<Server> {
  const app = express();

  // 设置写令牌
  setWriteToken(writeToken);

  // ======== 全局中间件 ========
  // hostCheck 需要真实绑定端口（port=0 时由系统分配），而中间件挂载在 listen 之前，
  // 故通过闭包持有 server 实例、每次请求时从 address() 动态解析端口
  let boundServer: Server | null = null;
  const resolvePort = (): number => {
    const addr = boundServer?.address();
    return typeof addr === "object" && addr !== null ? addr.port : port;
  };

  app.use(securityHeaders);   // 安全响应头
  app.use(localOnly);         // 限制本地访问（socket.remoteAddress）
  // v0.11 S-3: Host 头校验——DNS rebinding 时 remoteAddress 恰为 127.0.0.1，
  // localOnly 拦不住；GET 接口无 Origin 校验，靠 Host 白名单兜底
  app.use(createHostCheck(() => dashboardAllowedHosts(resolvePort())));
  app.use(rateLimiter);       // 请求频率限制
  app.use(originCheck);       // Origin 校验

  // v0.10.1: 上传路由专用 body parser（70MB）——必须挂在全局 256kb 解析器之前；
  // body-parser 解析成功后置 req._body=true，全局解析器会自动跳过，不会二次解析
  app.use("/api/upload", express.json({ limit: UPLOAD_BODY_SIZE_LIMIT }));

  app.use(express.json({ limit: BODY_SIZE_LIMIT }));

  // v0.10.1: body 超限（413）统一转成可识别错误码，避免落入兜底 INTERNAL_ERROR
  // （错误处理中间件需挂在两个 body parser 之后才能捕获其抛出的错误）
  app.use((err: Error & { statusCode?: number; status?: number }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const status = err.statusCode ?? err.status;
    if (status === 413) {
      res.status(413).json({
        error: { code: "PAYLOAD_TOO_LARGE", message: "request entity too large" },
        meta: { requestId: "" },
      });
      return;
    }
    next(err);
  });

  app.use(writeTokenGuard);   // 写令牌验证

  // ======== API 路由 ========
  app.use(createHealthRouter(writeToken));
  // v0.12 M-8: 连接视图（活跃远程连接 + 白名单，只读无需写令牌）
  app.use(createConnectionsRouter(deps.cwd));

  // v0.10.1: 上传成功后不再自动触发表卡片 LLM 起草（前端 AI 入口已撤除）；
  // draft API 路由与 ensureTableCard/draftCardWithLLM 函数保留，get_table_card 无卡片时仍有骨架卡兜底
  app.use(createUploadRouter({
    uploadsDir: deps.uploadsDir,
    engine: deps.engine,
    dataDictionary: deps.dictionaryManager ?? null,
  }));
  app.use(createReportsRouter(deps));
  app.use(createDictionariesRouter(deps));
  app.use(createDatasetsRouter(deps));
  app.use(createChartsRouter(deps));
  app.use(createSqlHistoryRouter(deps));
  app.use(createMetricsRouter(deps));
  app.use(createTableCardsRouter(deps));

  // ======== 静态资源（开发模式禁用缓存） ========
  const staticDir = join(import.meta.dirname, "static");
  const indexHtmlPath = join(staticDir, "index.html");
  app.use((req, res, next) => {
    // 对 HTML/JS/CSS 文件设置 no-cache，确保每次加载最新版本
    if (/\.(html|js|css|map)$/.test(req.path)) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
    next();
  });
  app.use(express.static(staticDir, { index: "index.html" }));

  // SPA fallback：所有未匹配的 GET 请求返回 index.html
  // 使用中间件而非路由，避免 Express 5 的 path-to-regexp 兼容性问题
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api/")) {
      res.sendFile(indexHtmlPath);
    } else {
      next();
    }
  });

  // ======== 错误处理 ========
  app.use(errorHandler);

  // ======== 启动 HTTP Server ========
  return new Promise<Server>((resolve, reject) => {
    const server = createServer(app);
    boundServer = server;

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      logger.debug(`HTTP server listening on 127.0.0.1:${port}`);
      resolve(server);
    });
  });
}
