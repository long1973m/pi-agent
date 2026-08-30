# Pi Data Agent Extension

基于 [Pi Extension API](https://pi.dev) + DuckDB 的数据分析智能体扩展：让 Pi 具备加载数据、SQL 查询、可视化、生成报告的完整分析能力，并以数据字典、查询记忆、表卡片三层知识库沉淀分析资产。

当前版本：**v0.11**（安全收口 + 工程健康）。

## 功能概览

- **数据加载**：CSV / Excel（.xlsx/.xls）上传自动建表，DuckDB 本地存储
- **SQL 查询**：自然语言 → SQL，带错误自修复（error-recovery）与查询记忆
- **知识库**：数据字典（AI 推断 + 用户确认状态机）、表卡片、指标口径、查询记忆，按 L0 导航 / L1 按需 / L2 注入三层渐进披露
- **可视化**：matplotlib 静态图（bar/line/scatter/histogram/pie/box/heatmap），Python 失败时自动回退 CSV
- **报告**：会话报告（HTML 单文件离线自包含）+ 正式分析报告（executive/detailed，证据覆盖度质量门）
- **Dashboard**：本地 Web 界面，浏览报告、管理数据字典与指标口径

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
| connect_database | 连接外部数据库（开发中） |
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

一句话：**写操作确认门 fail-closed（无 UI 环境不静默放行）、SQL 内嵌路径白名单 + 危险操作拦截、Dashboard 仅绑定本地回环并叠 Origin 校验 / 速率限制 / 安全响应头 / 写令牌四层中间件。**

## 版本历史

各版本执行规范与交付评审见 `../specs/` 与本目录 `v0.*-REVIEW-REPORT.md` / `v0.*-DELIVERY-REPORT.md`；跨版本欠账统一收录在 `../specs/BACKLOG.md`。
