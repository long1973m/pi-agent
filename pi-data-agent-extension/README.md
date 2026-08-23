# Pi Data Agent Extension - S0.1 PoC

Pi Data Agent 的 Extension PoC，用于验证 Pi Extension API 的核心能力。

## 验证点覆盖

| 验证点 | API | 状态 |
|--------|-----|------|
| 1 | `pi.registerTool` 注册 dummy 工具 | ✅ 通过 |
| 2 | `pi.on('session_start')` / `pi.on('session_shutdown')` | ✅ 通过 |
| 3 | `pi.on('before_agent_start')` 返回 `systemPromptAppend` | ✅ 通过 |
| 4 | `ctx.ui.confirm()` 阻塞等待用户确认 | ✅ 代码实现通过，TUI 模式待人工验证 |
| 5 | `ctx.ui.select()` 展示选项并接收选择 | ✅ 代码实现通过，TUI 模式待人工验证 |
| 6 | `ctx.sessionManager.getBranch()` 读写 session 数据 | ⏳ 代码已补充，待 Pi TUI 模式验证 |
| 7 | tool result `details` 传递结构化元数据 | ✅ 通过 |

> **验证点 6 说明**：`sessionManager.getBranch()` 的调用已添加到 `session_start` 事件处理中。
> 由于 `--print` 模式下 session 为空，需在 TUI 交互模式下验证有 entries 时的返回值格式。

## 安装

```bash
npm install
npm run build
```

## 加载到 Pi

```bash
pi -e /path/to/pi-data-agent-extension/dist/index.js
```

## 使用

加载后，Agent 可以调用 `poc_dummy` 工具：

```json
{
  "message": "Hello PoC",
  "trigger_confirm": true,
  "trigger_select": true
}
```

## 项目结构

```
pi-data-agent-extension/
├── src/
│   ├── index.ts          # Extension 入口
│   ├── poc-duckdb.ts     # S0.2 DuckDB 验证脚本
│   └── poc-chart.py      # S0.4 图表生成验证脚本
├── .pi-data-agent/
│   ├── session.duckdb    # DuckDB 数据文件
│   └── poc_*.png        # 图表验证输出
├── requirements.txt      # Python 依赖锁定
├── package.json
├── tsconfig.json
└── README.md
```
