# Pi Data Agent Extension

基于 [Pi Extension API](https://pi.dev) + DuckDB 的数据分析智能体扩展：让 Pi 具备加载数据、SQL 查询、可视化、生成报告的完整分析能力，并以数据字典、查询记忆、表卡片三层知识库沉淀分析资产。

当前版本：**v0.12**（MySQL 只读连接 + 多方言基座）。

## 功能概览

- **数据加载**：CSV / Excel（.xlsx/.xls）上传自动建表，DuckDB 本地存储
- **SQL 查询**：自然语言 → SQL，带错误自修复（error-recovery）与查询记忆
- **知识库**：数据字典（AI 推断 + 用户确认状态机）、表卡片、指标口径、查询记忆，按 L0 导航 / L1 按需 / L2 注入三层渐进披露
- **可视化**：matplotlib 静态图（bar/line/scatter/histogram/pie/box/heatmap），Python 失败时自动回退 CSV
- **报告**：会话报告（HTML 单文件离线自包含）+ 正式分析报告（executive/detailed，证据覆盖度质量门）
- **Dashboard**：本地 Web 界面，浏览报告、管理数据字典与指标口径
- **外部数据库**：MySQL 远程只读连接（v0.12），SQLite 本地文件；ATTACH 架构，远程表即普通 DuckDB 表，15 个工具全链路复用

## 工具清单

| 工具 | 用途 |
|------|------|
| load_data | 加载 CSV/Excel 文件为 DuckDB 表 |
| describe_data | 查看表结构、样例与统计概要 |
| query_data | 执行 SQL 查询（必填 sql + user_intent） |
| transform_data | 建表/物化转换结果 |
| list_datasets | 列出已加载数据集 |
| ask_clarification | 分析方向不明确时主动反问 |
| export_result | 导出查询结果 |
| visualize | 生成统计图表 |
| show_image | 在 TUI 展示图片 |
| connect_database | 连接外部数据库（sqlite 文件 / MySQL 只读远程） |
| confirm_dictionary | 数据字典确认入口 |
| generate_report | 生成正式分析报告 |
| generate_session_report | 生成会话报告 |
| get_table_card | 查询表卡片（用途/边界/字段含义） |

## 安装与加载

```bash
npm install
npm run build
pi -e /path/to/pi-data-agent-extension/dist/index.js
```

Python 绘图依赖见 `requirements.txt`（matplotlib / pandas / seaborn / numpy / scipy）。

## 测试

```bash
npm test            # 全量（vitest，51 文件 / 310 用例）
npm run test:watch  # watch 模式
npm run test:coverage
```

v0.11 起测试统一到 vitest（含 DuckDB 单连接串行约束，singleFork）。

## 数据库连接（v0.12）

`connect_database` 支持两类目标：

```text
# SQLite 本地文件
connect_database(db_type="sqlite", file_path="/path/to/data.db")

# MySQL 远程（只读）
connect_database(db_type="mysql", host="db.internal", port=3306, user="analyst", database="sales")
```

**MySQL 只读语义与配置**：

1. **连接强制 READ_ONLY**（客户端约束）。服务端账号请使用 `GRANT SELECT ONLY`——客户端 READ_ONLY 不是安全边界。写入远程库不支持，此类请求应拒绝。
2. **白名单前置**：只有 `dbAllowedHosts` 白名单内的 host 才允许连接，**默认空 = 拒绝一切远程**。配置方式（二选一）：
   - env：`PI_DATA_AGENT_DB_ALLOWED_HOSTS="db.internal:3306;10.0.0.5"`（分号分隔，支持 `host` 与 `host:port` 两种格式；`localhost` 与 `127.0.0.1` 视为不同目标）
   - config.json（`.pi-data-agent/config.json`）：`{ "dbAllowedHosts": ["db.internal:3306"] }`
3. **凭据三种配置方式**（密码永不作为工具参数——工具参数会整体进入模型上下文）：
   - env `PI_DATA_AGENT_MYSQL_PWD`（项目命名空间，优先）
   - env `MYSQL_PWD`（DuckDB mysql 扩展原生识别）
   - 交互模式下弹出密码输入框（结果仅存入 temporary secret，不落盘）
4. **查询超时**：`dbQueryTimeoutMs`（默认 300000，夹紧 5s~10min），传给 `mysql_query_timeout_max_ms`。
5. **离线环境**：首次连接需下载 mysql/sqlite 扩展（约 10MB）。离线时预置扩展到 `~/.duckdb/extensions/<duckdb版本>/<os>_<arch>/`，或 `SET extension_directory` 指向本地目录。
6. **已知精度坑**：MySQL `DECIMAL(p>38)` 列落地为 DOUBLE（DuckDB 上限 DECIMAL(38)）；`mysql_query()` 表函数因 issue #65 禁用，统一走 ATTACH。

## 目录结构

```
pi-data-agent-extension/
├── src/
│   ├── index.ts            # Extension 入口（生命周期 + 14 工具注册）
│   ├── config.ts           # 配置加载（env > 项目配置 > 默认值）
│   ├── security.ts         # SQL 安全检查（确认门 fail-closed、路径白名单）
│   ├── persistence.ts      # 配置/字典/记忆持久化
│   ├── error-recovery.ts   # 错误自修复
│   ├── engine/             # DuckDB 引擎 + Python 无状态调用
│   ├── tools/              # 14 个工具实现
│   ├── dashboard/          # 本地 Web Dashboard（server/routes/services/middleware）
│   ├── hooks/              # 数据字典、查询记忆、主动反问
│   ├── navigation/         # L0 导航上下文渲染
│   ├── metrics/            # 指标口径定义
│   ├── report/             # 分析报告生成管线
│   ├── table-cards/        # 表卡片存储
│   ├── llm/                # LLM 调用收敛层
│   └── eval/               # 全部测试（vitest）+ fixtures
├── scripts/                # generate_chart.py / check_python_env.py
└── dist/                   # 构建产物（pi -e 加载入口）
```

## 安全模型

一句话：**写操作确认门 fail-closed（无 UI 环境不静默放行）、SQL 内嵌路径白名单 + 危险操作拦截、模型侧 ATTACH/DETACH 一律拦截（远程连接只允许走 connect_database 工具实现层）、远程目标白名单 fail-closed（默认拒绝一切远程）、凭据不进工具参数/错误文本/审计日志（redactCredentials 兜底）、Dashboard 仅绑定本地回环并叠 Origin 校验 / 速率限制 / 安全响应头 / 写令牌四层中间件。**

## 版本历史

各版本执行规范与交付评审见 `../specs/` 与本目录 `v0.*-REVIEW-REPORT.md` / `v0.*-DELIVERY-REPORT.md`；跨版本欠账统一收录在 `../specs/BACKLOG.md`。
