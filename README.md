# Pi Agent 项目结构指南

> 本文件是项目文件夹的归置约定。生成新文件时，按下方规则放入对应目录。

---

## 目录总览

```
pi-agent/
├── specs/                      # 执行规范与过程文档
├── pi-design/                  # Pi 功能设计与架构
├── acceptance-guides/          # 验收指南（HTML）
├── delivery-reviews/           # 交付评审（HTML）
├── research/                   # 调研文档
├── pi-data-agent-extension/    # 核心代码（扩展实现）
├── .pi-data-agent/             # 运行时数据（勿手动修改）
├── .uploads/                   # 用户上传的原始文件
├── .trae-html-share-packages/  # HTML 分享压缩包
└── README.md                   # 本文件
```

---

## 各目录职责与归置规则

### `specs/` — 执行规范与过程文档

存放面向开发者的落地执行指南、版本迭代规范、进度跟踪清单。

| 放入条件 | 示例 |
|---------|------|
| EXECUTION_SPEC、IMPLEMENTATION_SPEC 等执行规范 | `EXECUTION_SPEC.md` |
| 各版本迭代执行规范 | `v0.2-EXECUTION_SPEC.md` ~ `v0.8-EXECUTION_SPEC.md` |
| 进度跟踪清单 | `v0.2-PROGRESS-CHECKLIST.md` ~ `v0.5-PROGRESS-CHECKLIST.md` |
| MVP 实现步骤、Gap 修复清单 | `MVP-IMPLEMENTATION-STEPS.md`、`phase1-gap-fix-checklist.md` |
| 代码评审报告 | `code-review-report-mvp.md` |

**命名约定**：版本类文件以 `v{X.Y}-` 前缀开头；无版本的全局规范不加前缀。

### `pi-design/` — Pi 功能设计与架构

存放与 Pi Agent 功能设计、技术架构相关的文档及其 HTML 可视化交付。

| 放入条件 | 示例 |
|---------|------|
| Pi 源码架构分析 | `pi-analysis-plan.md` |
| 技术架构设计文档 | `pi-data-agent-architecture.md` |
| 架构设计 HTML 交付 | `pi-data-agent-architecture/` |
| Dashboard 等功能设计 HTML | `pi-data-dashboard-design/` |

**判断标准**：文档主题是"Pi 的功能应该怎么设计"或"架构是怎样的"，放这里；如果是"代码该怎么写、按什么步骤执行"，放 `specs/`。

### `acceptance-guides/` — 验收指南

存放各版本手动验收指南（HTML 格式），用于功能交付后的人工检查。

| 放入条件 | 示例 |
|---------|------|
| 版本验收指南 HTML | `mvp-manual-acceptance-guide.html`、`v0.2-manual-acceptance-guide.html` ~ `v08-acceptance-guide.html` |

**命名约定**：`{版本}-acceptance-guide.html` 或 `{版本}-manual-acceptance-guide.html`。

### `delivery-reviews/` — 交付评审

存放版本交付评审报告（HTML 格式，含 `_shared/` 字体等资源）。

| 放入条件 | 示例 |
|---------|------|
| 版本交付评审 HTML 目录 | `delivery-review/`、`v0.2-delivery-review/`、`v0.3-delivery-review/` |
| MVP 范围收尾评审 | `mvp-scope-closure/` |

**与 acceptance-guides 的区别**：验收指南是"检查清单"（逐项打勾），交付评审是"总结报告"（回顾做了什么、做得怎么样）。

### `research/` — 调研文档

存放竞品分析、技术选型调研等前瞻性研究文档。

| 放入条件 | 示例 |
|---------|------|
| 竞品调研报告 | `competitor-analysis.md` |
| 技术选型对比 | — |

**判断标准**：文档目的是"了解外部世界"（竞品、技术趋势）而非"指导本项目实现"，放这里。

### `pi-data-agent-extension/` — 核心代码

Pi Data Agent 扩展的完整实现（TypeScript 源码、编译产物、测试、依赖）。**不要把文档放进来**，文档归 `specs/` 或 `pi-design/`。

### 隐藏目录（勿手动修改）

| 目录 | 用途 |
|------|------|
| `.pi-data-agent/` | Agent 运行时状态、DuckDB 会话数据库 |
| `.uploads/` | 用户上传的原始数据文件 |
| `.trae-html-share-packages/` | HTML 交付物的分享压缩包 |

---

## 新文件归置速查

遇到新文件时，按以下顺序判断：

1. **是代码或测试？** → `pi-data-agent-extension/`
2. **是执行规范、进度清单、评审报告？** → `specs/`
3. **是 Pi 功能/架构设计？** → `pi-design/`
4. **是验收检查清单（HTML）？** → `acceptance-guides/`
5. **是交付评审报告（HTML）？** → `delivery-reviews/`
6. **是竞品/技术调研？** → `research/`
7. **是运行时数据？** → 对应隐藏目录（勿手动操作）

**存疑时**：优先看文件内容的"动词属性"——"设计/分析"归 `pi-design` 或 `research`，"执行/实现/检查"归 `specs`，"验收/评审"归对应 HTML 目录。
