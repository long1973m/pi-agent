---
name: statistical-analysis
version: "1.0.0"
priority: 10
description: |
  基础统计分析 Skill — 帮助用户进行分组描述统计、相关性分析、异常值检测和简单趋势分析。
  适用于"整体情况如何"、"有没有关系"、"有没有异常"、"趋势怎么样"等请求。
  不做复杂回归、因果推断或预测建模。
tags: ["statistics", "analysis", "correlation", "anomaly", "trend"]
requires:
  - query_data
  - visualize
  - ask_clarification
scripts:
  stats-summary: ./scripts/stats-summary.sql
  correlation: ./scripts/correlation.sql
  anomaly-detection: ./scripts/anomaly-detection.sql
  trend-analysis: ./scripts/trend-analysis.sql
---

# Statistical Analysis Skill

## 触发条件

当用户出现以下意图时，优先使用本 Skill：

- "整体情况如何" / "数据分布怎么样" / "做个描述统计"
- "有没有关系" / "相不相关" / "有没有关联"
- "有没有异常" / "有没有离群值" / "有没有问题"
- "趋势怎么样" / "增长还是下降" / "变化趋势"
- "统计分析" / "统计一下"

## 适用场景

| 场景 | 分析方法 | 输出 |
|------|----------|------|
| 了解数据整体分布 | 分组描述统计 | count / mean / median / min / max / stddev |
| 数值字段之间是否相关 | 相关性分析 | 相关系数矩阵 |
| 查找极端值或异常波动 | 异常值检测 | 异常值列表 + IQR/Z-score |
| 观察随时间的变化 | 简单趋势分析 | 环比变化率 + 趋势判断 |

## 不适用场景（明确边界）

以下需求**不使用**本 Skill，应引导用户使用其他方式或明确告知限制：

| 需求 | 原因 | 回应方式 |
|------|------|----------|
| 复杂回归分析 | 需要建模假设检验，超出 v0.3 范围 | "当前版本不做回归建模，可提供相关性分析作为替代" |
| 因果推断 | 相关性不等于因果，无法从数据中推断因果 | "数据只能展示相关性，无法证明因果关系" |
| 预测未来值 | 需要时间序列建模能力 | "当前版本不做预测，可展示历史趋势" |
| 机器学习训练 | 需要特征工程和模型训练流程 | "超出当前 Agent 能力范围" |
| 假设检验大全 | 需要统计显著性判断和分布假设 | "当前只做探索性分析，不做假设检验" |

## 统计方法选择规则

根据用户自然语言意图自动选择：

```
用户问"整体情况" / "分布" / "描述" / "统计概况"
  → 分组描述统计（stats-summary.sql）

用户问"有没有关系" / "相不相关" / "关联" / "correlation"
  → 相关性分析（correlation.sql）

用户问"异常" / "离群" / "反常" / "outlier" / "问题"
  → 异常值检测（anomaly-detection.sql）

用户问"趋势" / "变化" / "增长" / "下降" / "环比" / "同比"
  → 简单趋势分析（trend-analysis.sql）
```

## 执行策略

### Phase 1: 意图识别

1. 判断用户请求是否明确指向某一类统计分析
2. 模糊时触发 `ask_clarification`（见下方反问模板）
3. 明确时直接进入 Phase 2

### Phase 2: 方法执行

1. 确认数据集已加载（如未加载，提示用户使用 `load_data`）
2. 根据方法选择规则确定分析类型
3. 通过 `describe_data` 确认字段类型（数值型 vs 分类型）
4. 从本 Skill 的 SQL 模板中选择合适的查询模板
5. 构造 SQL 并调用 `query_data` 执行
6. 根据结果做趋势/异常判断（Agent 端逻辑）
7. 如需可视化，调用 `visualize`

### Phase 3: 结果解释

向用户说明：
- 使用的分析方法
- 关键发现（如最高/最低均值、最强相关性、异常值数量、趋势方向）
- 数据范围和字段
- **不确定性说明**（见下方模板）

## 主动反问模板

当用户说"分析一下数据"、"看看有没有问题"、"做个统计分析"但未指定目标时，必须反问：

```yaml
question: "你想优先看哪类统计分析？"
why: "不同类型的统计分析回答不同的问题，需要明确分析目标"
options:
  - id: summary
    label: "整体分布：均值、中位数、分位数、缺失率"
    implied_assumption: "用户想了解数据整体分布特征，使用分组描述统计"
  - id: group_compare
    label: "分组对比：按类别字段比较关键指标"
    implied_assumption: "用户想按分类维度对比数值指标，使用分组描述统计"
  - id: anomaly
    label: "异常检测：查找极端值、异常波动、缺失异常"
    implied_assumption: "用户想发现数据中的异常点，使用 IQR/Z-score 异常检测"
  - id: correlation
    label: "相关性：查看数值字段之间是否相关"
    implied_assumption: "用户想分析数值字段之间的线性相关性，使用相关系数矩阵"
default_if_skip: summary
```

## 不确定性说明模板

**必须**在每次统计分析输出中包含以下内容之一：

### 相关性分析

> ⚠️ 相关性不等于因果关系。上述相关系数仅表示两个变量之间的线性关联强度，不能说明一个变量的变化是另一个变量变化的原因。可能存在混杂变量或反向因果。

### 异常值检测

> ⚠️ 异常值检测基于统计分布（IQR/Z-score），被标记的异常值可能是真实业务现象（如促销活动导致销量激增），不一定是数据错误。建议结合业务背景判断。

### 趋势分析

> ⚠️ 趋势判断基于历史数据的环比变化，不代表未来走势。外部因素（季节、政策、市场环境）可能导致趋势逆转。

### 分组描述统计

> ⚠️ 描述统计基于当前数据集，如果数据存在选择偏差或采样偏差，统计结果可能不反映总体情况。

## 趋势判断逻辑（Agent 端）

执行 `trend-analysis.sql` 后，根据 change_rate 列判断趋势：

```
连续 3 期 change_rate > 0   → "上升趋势"
连续 3 期 change_rate < 0   → "下降趋势"
正负交替                   → "波动趋势"
|change_rate| < 5%         → "基本平稳"
```

**注意**：趋势判断需要至少 4 个数据点（才能计算 3 个 change_rate）。数据不足时说明"数据点不足，无法判断趋势"。

## SQL 模板引用

| 分析类型 | SQL 模板 | DuckDB 特性 |
|---------|---------|------------|
| 分组描述统计 | `scripts/stats-summary.sql` | MEDIAN, STDDEV, PERCENTILE |
| 相关性分析 | `scripts/correlation.sql` | CORR() 函数 |
| 异常值检测 | `scripts/anomaly-detection.sql` | PERCENTILE + IQR |
| 趋势分析 | `scripts/trend-analysis.sql` | LAG() 窗口函数 |

## 常见失败场景与处理

### 场景 1: 字段类型不匹配

**表现**: 用户想对字符串列做相关性分析。

**处理**:
1. 检查字段类型（通过 `describe_data`）
2. 解释相关性分析只适用于数值列
3. 建议：分类列可用分组描述统计，或先做编码转换

### 场景 2: 数据量过小

**表现**: 表只有 1-2 行，无法计算有意义的中位数或趋势。

**处理**:
1. 说明当前数据量不足以进行可靠的统计分析
2. 建议加载更多数据或降低分析粒度

### 场景 3: 缺少时间字段

**表现**: 用户问趋势但表中没有日期/时间列。

**处理**:
1. 通过 `describe_data` 确认字段类型
2. 告知用户趋势分析需要至少一个日期/时间列
3. 建议改用分组描述统计了解数据分布

## 示例对话

### 示例 1: 模糊请求 → 反问 → 分组描述统计

**用户**: "分析一下 sales 数据"

**Agent**: 触发 `ask_clarification`（反问模板）

**用户**: 选择"整体分布"

**Agent**:
1. `describe_data("sales")` — 确认字段
2. 选择 stats-summary.sql 模板
3. `query_data(sql="SELECT category, COUNT(*) AS cnt, AVG(amount) AS avg_amount, MEDIAN(amount) AS median_amount, MIN(amount) AS min_amount, MAX(amount) AS max_amount FROM sales GROUP BY category")`
4. 解释结果 + 不确定性说明

### 示例 2: 明确请求 → 相关性分析

**用户**: "看看 amount 和 quantity 有没有关系"

**Agent**:
1. `describe_data("sales")` — 确认 amount 和 quantity 都是数值列
2. 选择 correlation.sql 模板
3. `query_data(sql="SELECT CORR(amount, quantity) AS correlation FROM sales")`
4. 解释相关系数含义 + **相关性≠因果**警告

### 示例 3: 异常检测

**用户**: "销售额有没有异常高的日期？"

**Agent**:
1. `describe_data("sales")` — 确认有 amount 和 date 字段
2. 选择 anomaly-detection.sql 模板
3. `query_data(sql="WITH stats AS (SELECT PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY amount) AS q1, PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY amount) AS q3 FROM sales) SELECT * FROM sales, stats WHERE amount > q3 + 1.5 * (q3 - q1) ORDER BY amount DESC")`
4. 列出异常日期和金额 + 不确定性说明
