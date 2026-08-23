---
name: data-exploration
version: "1.0.0"
priority: 10
description: |
  数据探索 Skill — 帮助用户快速理解数据集的结构、分布和特征。
  适用于首次接触数据集时的概览分析，以及回答 "这张表有什么数据"、
  "各列分布如何" 等问题。
tags: ["data", "exploration", "overview", "statistics"]
requires:
  - load_data
  - describe_data
  - query_data
scripts:
  overview: ./scripts/overview.sql
---

# Data Exploration Skill

## 触发条件

当用户出现以下意图时，优先使用本 Skill：

- "看看这张表有什么"
- "描述一下数据"
- "数据的分布如何"
- "各列统计信息"
- "数据概览"
- 任何首次接触数据集时的探索性问题

## 执行策略

### Phase 1: 结构概览

1. 确认数据已加载（如未加载，提示用户使用 `load_data`）
2. 使用 `describe_data` 获取表结构和统计摘要
3. 展示列名、类型、行数、NULL 比例

### Phase 2: 深入分析

根据数据类型执行不同分析：

**数值列:**
- SUMMARIZE 获取 min/max/avg/std
- 分布直方图（通过 query_data 分段统计）

**分类列:**
- 唯一值数量
- 高频值 TOP 20
-  cardinality 评估

**时间列:**
- 时间范围
- 记录频率趋势

## 主动反问模板

当用户请求模糊时使用，对齐 `ask_clarification` 工具契约。

### 模板 1: 分析范围不明

```yaml
question: "你想看哪部分数据的概览？"
why: "表可能很大，全量分析耗时较长"
options:
  - id: full
    label: "全部数据"
    implied_assumption: "对整个表做全量统计"
  - id: sample
    label: "前 1000 行样本"
    implied_assumption: "用样本快速了解结构，不保证分布代表性"
  - id: recent
    label: "最近的数据"
    implied_assumption: "按时间倒序取最近 1000 条，适合时序数据"
default_if_skip: sample
```

### 模板 2: 分析深度不明

```yaml
question: "你希望看到什么粒度的分析？"
why: "不同场景需要不同深度的信息"
options:
  - id: basic
    label: "基础概览（列名 + 类型 + 行数）"
    implied_assumption: "只关注数据结构，不做统计分布"
  - id: standard
    label: "标准分析（含分布、高频值）"
    implied_assumption: "包含各列统计摘要和分类列的高频值"
  - id: deep
    label: "深度分析（含相关性、异常检测）"
    implied_assumption: "额外分析列间相关性和潜在异常值"
default_if_skip: standard
```

## 解释规则

### 怎么看 SUMMARIZE 结果

- **min/max**: 数值范围，检查是否有异常值（如年龄为负数）
- **avg**: 平均值，注意被极端值拉偏的情况
- **std**: 标准差，> avg 的 50% 说明分布很分散
- **q25/q50/q75**: 四分位数，看分布是否对称
- **null_percentage**: NULL 比例，> 30% 的列可能需要清洗

### 怎么看高频值

- **TOP 1 占比 > 50%**: 该列几乎只有一个值，信息量低
- **均匀分布**: 各值数量接近，适合作为分组维度
- **长尾分布**: 少数值高频，多数值低频，注意是否需要合并稀有值

### 怎么看 cardinality

- **cardinality / 总行数 ≈ 1**: 接近唯一值（如 ID），适合做主键
- **cardinality 很小（< 20）**: 明显的分类列
- **cardinality 很大（> 10000）**: 自由文本或高粒度标识符

## 示例对话

**用户**: "看看 iris 数据集"

**Agent**:
1. `list_datasets` — 确认 iris 已加载
2. `describe_data` — 获取结构和统计
3. 回复：展示列名、类型、行数、各列统计摘要
4. 如果分类列（species）展示高频值分布
