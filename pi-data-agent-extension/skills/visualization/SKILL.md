---
name: visualization
version: "1.0.0"
priority: 10
description: |
  数据可视化 Skill — 帮助用户选择合适的图表类型并生成可视化。
  适用于"画个图"、"可视化一下"、"看看分布"、"对比下各组数据"等请求。
  支持 7 种图表：bar（柱状图）、line（折线图）、scatter（散点图）、
  histogram（直方图）、pie（饼图）、box（箱线图）、heatmap（热力图）。
tags: ["visualization", "chart", "plot", "graph"]
requires:
  - visualize
  - show_image
  - ask_clarification
scripts:
  chart-templates: ./scripts/chart-templates.sql
---

# Visualization Skill

## 触发条件

当用户出现以下意图时，优先使用本 Skill：

- "画个图"
- "可视化一下"
- "画个柱状图/折线图/散点图"
- "看看分布"
- "对比下各组数据"
- "展示占比"
- "看看相关性"
- 任何涉及图表、图形、可视化展示数据的请求

## 图表选择规则

### 按数据关系选择

| 你想展示什么 | 推荐图表 | 替代方案 | 说明 |
|-------------|---------|---------|------|
| 分类比较（谁多谁少） | **bar** | — | 类别在 X 轴，数值在 Y 轴 |
| 时间趋势（随时间变化） | **line** | bar（时间点很少时） | 时间/有序类别在 X 轴 |
| 两个数值变量的关系 | **scatter** | — | X 和 Y 都是数值列 |
| 单变量分布/频率 | **histogram** | box（比较多组时） | 只需要一个数值列 |
| 占比/构成（部分与整体） | **pie** | bar（类别 > 6 时不推荐 pie） | 需要分类 + 数值 |
| 多组统计分布对比 | **box** | histogram（单组时） | 需要一个分类列 + 一个数值列 |
| 多变量相关性矩阵 | **heatmap** | scatter（只看两两关系时） | 需要多个数值列 |

### 不推荐场景

- **pie**：类别 > 6 时避免使用（人类不擅长比较角度），改用 bar
- **3D 图表**：永远不要使用（扭曲感知，不增加信息）
- **双轴图**：谨慎使用，容易误导相关性

### 字段选择规则

**维度字段（分类/时间）：**
- 用于 bar/line/pie 的 X 轴
- 用于 scatter/box 的颜色分组（可选）
- 类型：字符串、日期、低基数数值

**度量字段（数值）：**
- 用于 bar/line/pie 的 Y 轴
- 用于 scatter 的 X 和 Y
- 用于 histogram 的分布
- 用于 box 的统计分布
- 用于 heatmap 的相关性计算
- 类型：数值型

## 执行策略

### Phase 1: 意图识别

1. 判断用户请求是否模糊
2. 模糊时触发 `ask_clarification`（见下方反问模板）
3. 明确时直接进入 Phase 2

### Phase 2: 图表构建

1. 确认数据集已加载（如未加载，提示用户使用 `load_data`）
2. 根据图表类型选择规则确定 `chart_type`
3. 根据字段选择规则确定 `x_column`、`y_column` 或 `columns`
4. 构造合适的 SQL 查询（参考 `scripts/chart-templates.sql`）
5. 调用 `visualize` 工具生成 PNG
6. 调用 `show_image` 展示图片（或返回路径）

### Phase 3: 结果解释

向用户说明：
- 图表类型和展示目的
- 关键发现（如最高/最低值、趋势方向、异常点）
- 数据行数和使用的字段

## 主动反问模板

当用户请求模糊时使用，对齐 `ask_clarification` 工具契约。

### 模板 1: 图表类型不明确

```yaml
question: "你想用什么类型的图表来展示数据？"
why: "不同图表适合展示不同的数据关系，选错图表会导致信息传达不清晰"
options:
  - id: bar
    label: "柱状图（对比不同类别的数值大小）"
    implied_assumption: "用户想比较不同类别的数值，使用 bar 图表"
  - id: line
    label: "折线图（展示随时间变化的趋势）"
    implied_assumption: "用户想观察数据随时间/有序类别的变化趋势，使用 line 图表"
  - id: scatter
    label: "散点图（看两个数值变量的关系）"
    implied_assumption: "用户想分析两个数值变量之间的相关性，使用 scatter 图表"
  - id: histogram
    label: "直方图（看数据分布/频率）"
    implied_assumption: "用户想了解单个数值变量的分布情况，使用 histogram 图表"
  - id: pie
    label: "饼图（看占比/构成）"
    implied_assumption: "用户想看各部分占总体的比例，使用 pie 图表"
  - id: box
    label: "箱线图（比较多组统计分布）"
    implied_assumption: "用户想对比多组数据的统计分布特征，使用 box 图表"
  - id: heatmap
    label: "热力图（看多变量相关性）"
    implied_assumption: "用户想看多个数值变量之间的相关性矩阵，使用 heatmap 图表"
default_if_skip: bar
```

### 模板 2: 分析目标不明确

```yaml
question: "你想通过图表展示什么信息？"
why: "明确分析目标有助于自动选择最合适的图表和字段"
options:
  - id: compare
    label: "比较不同类别的数值大小"
    implied_assumption: "使用 bar 图表，按分类列分组统计"
  - id: trend
    label: "观察随时间变化的趋势"
    implied_assumption: "使用 line 图表，按时间列排序"
  - id: relationship
    label: "分析两个变量的关系"
    implied_assumption: "使用 scatter 图表，X 和 Y 各选一个数值列"
  - id: distribution
    label: "了解数据的分布情况"
    implied_assumption: "使用 histogram 图表，直接展示数值列的分布"
  - id: proportion
    label: "看各部分占比"
    implied_assumption: "使用 pie 图表，按分类列统计频次"
  - id: stats_compare
    label: "比较多组统计特征"
    implied_assumption: "使用 box 图表，分类列做分组，数值列做统计"
  - id: correlation
    label: "看多个变量的相关性"
    implied_assumption: "使用 heatmap 图表，计算多个数值列的相关性矩阵"
default_if_skip: compare
```

### 模板 3: 字段不明确

```yaml
question: "你想用哪些字段来画图？"
why: "需要确定维度字段（分类/时间）和度量字段（数值）"
options:
  - id: auto
    label: "自动推断（根据数据类型选择）"
    implied_assumption: "Agent 自动识别字符串/日期列作为维度，数值列作为度量"
  - id: manual
    label: "我指定字段"
    implied_assumption: "用户将明确指定 x_column、y_column 或 columns"
default_if_skip: auto
```

## SQL 查询构建指南

参考 `scripts/chart-templates.sql` 中的模板，根据图表类型构造查询：

| 图表类型 | SQL 模式 | 示例 |
|---------|---------|------|
| bar | `SELECT dim, AGG(measure) FROM t GROUP BY dim ORDER BY dim` | `SELECT species, COUNT(*) FROM iris GROUP BY species` |
| line | `SELECT time_dim, AGG(measure) FROM t GROUP BY time_dim ORDER BY time_dim` | `SELECT date, SUM(revenue) FROM sales GROUP BY date ORDER BY date` |
| scatter | `SELECT measure_x, measure_y, dim FROM t` | `SELECT sepal_length, sepal_width, species FROM iris` |
| histogram | `SELECT measure FROM t` | `SELECT sepal_length FROM iris` |
| pie | `SELECT dim, COUNT(*) FROM t GROUP BY dim` | `SELECT species, COUNT(*) FROM iris GROUP BY species` |
| box | `SELECT measure_x, measure_y, measure_z FROM t` 或 `SELECT dim, measure FROM t` | `SELECT sepal_length, sepal_width, petal_length FROM iris` |
| heatmap | `SELECT measure_a, measure_b, ... FROM t` | `SELECT sepal_length, sepal_width, petal_length, petal_width FROM iris` |

## 常见失败场景与处理

### 场景 1: 请求的图表类型不支持

**表现**: 用户请求 radar/funnel/sankey 等未实现的图表类型。

**处理**:
1. 告知用户当前支持 7 种图表类型
2. 推荐最接近的替代方案（如 radar → bar 做多维度对比）
3. 如果替代方案不合适，建议用 `export_result` 导出 CSV 后用外部工具处理

### 场景 2: 字段类型不匹配

**表现**: 用户想用字符串列做 scatter 的 X/Y，或只有一列数据却要求 bar。

**处理**:
1. 检查字段类型（通过 `describe_data`）
2. 解释为什么当前字段不适合该图表类型
3. 推荐合适的图表类型或建议数据转换（如字符串列用 bar 做频次统计）

### 场景 3: 数据量过大

**表现**: 查询结果行数 > 10000，图表生成缓慢或 PNG 过大。

**处理**:
1. 建议对数据做聚合（GROUP BY）后再可视化
2. 或建议采样（随机取 1000 条）做探索性分析
3. 告知用户聚合/采样后的图表可能丢失细节

### 场景 4: 可视化工具失败

**表现**: `visualize` 返回 fallback（CSV 路径 + 错误原因）。

**处理**:
1. 向用户说明图表生成失败的原因
2. 提供 CSV 文件路径作为 fallback
3. 建议用户可以下载 CSV 用 Excel/Tableau 等外部工具可视化

## 示例对话

### 示例 1: 模糊请求 → 反问 → 选择 → 可视化

**用户**: "画个图看看 iris 数据"

**Agent**: 触发 `ask_clarification`（模板 2: 分析目标不明确）
- 选项 A: 比较不同品种的数值大小
- 选项 B: 观察随时间变化的趋势
- 选项 C: 分析两个变量的关系
- 选项 D: 了解数据分布
- ...

**用户**: 选择 A（比较不同品种的数值大小）

**Agent**: 进一步询问具体字段（模板 3），或自动推断
1. `describe_data` — 确认字段类型
2. 自动选择 bar 图表
3. 调用 `visualize(sql="SELECT species, AVG(sepal_length) AS avg_length FROM iris GROUP BY species", chart_type="bar", x_column="species", y_column="avg_length", title="Average Sepal Length by Species")`
4. 调用 `show_image` 展示结果
5. 回复：展示图表 + 关键发现（如 virginica 平均花萼长度最大）

### 示例 2: 明确请求 → 直接可视化

**用户**: "给我画个 iris 各品种数量的饼图"

**Agent**:
1. 确认意图明确（pie 图表 + 已知字段 species）
2. 调用 `visualize(sql="SELECT species, COUNT(*) AS cnt FROM iris GROUP BY species", chart_type="pie", x_column="species", y_column="cnt", title="Species Distribution")`
3. 调用 `show_image` 展示结果
4. 回复：展示图表 + 说明各品种数量均等（各 10 条）

### 示例 3: 字段不匹配 → 建议替代

**用户**: "用 species 和 sepal_length 画个散点图"

**Agent**:
1. 分析字段类型：species 是字符串（分类），sepal_length 是数值
2. scatter 需要 X 和 Y 都是数值列
3. 建议替代方案：
   - "scatter 需要两个数值列，species 是分类列。建议改用 box 图表展示各品种的花萼长度分布，或者选择另一个数值列做 scatter"
4. 触发 `ask_clarification` 让用户选择
