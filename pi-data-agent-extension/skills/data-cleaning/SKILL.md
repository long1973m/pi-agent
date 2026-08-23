---
name: data-cleaning
version: "1.0.0"
priority: 10
description: |
  数据清洗 Skill — 帮助用户发现并处理数据质量问题。
  适用于"检查数据质量"、"看看有没有异常"、"数据清洗"、
  "缺失值处理"、"去重"等请求。
  支持缺失值检查、重复值检查、异常值检测、格式一致性检查。
tags: ["cleaning", "quality", "missing", "duplicate", "outlier"]
requires:
  - describe_data
  - query_data
  - transform_data
  - ask_clarification
scripts:
  cleaning-checks: ./scripts/cleaning-checks.sql
---

# Data Cleaning Skill

## 触发条件

当用户出现以下意图时，优先使用本 Skill：

- "检查数据质量"
- "看看有没有异常值"
- "数据清洗"
- "处理缺失值"
- "去重"
- "数据有脏数据吗"
- "检查数据完整性"
- 任何涉及数据质量、脏数据、缺失、重复、异常的请求

## 检查策略

### 1. 缺失值检查

| 检查项 | SQL 模式 | 判定标准 |
|--------|---------|---------|
| 单列 NULL 占比 | `SUM(CASE WHEN col IS NULL THEN 1 ELSE 0 END) / COUNT(*)` | > 30% 需要关注 |
| 全表 NULL 概览 | 每列单独统计 NULL 占比 | 展示热力图式的列报告 |
| 行级 NULL 密度 | 统计每行的 NULL 列数 | > 50% 列为 NULL 的行需关注 |

**处理建议：**
- NULL 占比 < 5%：可忽略或用均值/中位数填充
- NULL 占比 5%~30%：建议填充（数值用中位数，分类用众数）
- NULL 占比 > 30%：考虑删除该列或标记为特殊值

### 2. 重复值检查

| 检查项 | SQL 模式 | 判定标准 |
|--------|---------|---------|
| 完全重复行 | `GROUP BY ALL HAVING COUNT(*) > 1` | 任何重复都需报告 |
| 主键重复 | `GROUP BY key_cols HAVING COUNT(*) > 1` | 主键重复是严重问题 |
| 单列值重复 | `GROUP BY col HAVING COUNT(*) > 1` | 非预期重复需报告 |
| 重复比例 | `(总行数 - 去重行数) / 总行数` | > 5% 需要关注 |

**处理建议：**
- 主键重复：需要用户确认保留策略（保留第一条/最后一条/合并）
- 完全重复行：直接去重
- 业务重复（如同一用户多条记录）：需要用户确认

### 3. 异常值检查

| 检查项 | SQL 模式 | 判定标准 |
|--------|---------|---------|
| IQR 异常值 | `col < Q1 - 1.5*IQR OR col > Q3 + 1.5*IQR` | 标准箱线图方法 |
| Z-score 异常值 | `ABS(col - mean) / std > 3` | 适用于正态分布数据 |
| 负值检查 | `col < 0` | 仅适用于本应为正的字段 |
| 统计摘要 | `MIN/MAX/AVG/Q1/Q3/IQR` | 辅助判断 |

**处理建议：**
- 少量异常值（< 1%）：可用截断（cap 到 Q1/Q3）或删除
- 中等异常值（1%~5%）：需要用户确认业务含义
- 大量异常值（> 5%）：可能是数据本身特性，不应删除

### 4. 格式一致性检查

| 检查项 | SQL 模式 | 判定标准 |
|--------|---------|---------|
| 前后空格 | `col LIKE ' %' OR col LIKE '% '` | 任何匹配都需报告 |
| 大小写不一致 | `COUNT(DISTINCT col) > 1 GROUP BY LOWER(col)` | 同一值不同写法 |
| 类型异常 | `TYPEOF(col) 不一致` | 数值列中混入字符串 |

**处理建议：**
- 前后空格：TRIM() 清洗
- 大小写不一致：统一为小写或大写
- 类型异常：尝试 CAST 转换

## 执行策略

### Phase 1: 质量评估

1. 确认数据已加载（如未加载，提示用户使用 `load_data`）
2. 使用 `describe_data` 获取表结构和基本统计
3. 识别需要检查的字段类型（数值/分类/时间）

### Phase 2: 分项检查

根据数据特征执行检查（参考 `scripts/cleaning-checks.sql`）：

**数值列** → 异常值检查（IQR + Z-score）+ 缺失值
**分类列** → 重复值检查 + 格式一致性 + 缺失值
**时间列** → 缺失值 + 格式检查
**所有列** → 完全重复行检查

### Phase 3: 报告 + 建议

1. 汇总检查结果为质量报告
2. 按严重度排序（严重/警告/建议）
3. 对每个问题提供处理建议
4. 如用户同意，使用 `transform_data` 执行清洗

### Phase 4: 清洗执行（用户确认后）

使用 `transform_data` 执行 SQL 变更：
- 去重：`CREATE TABLE clean AS SELECT DISTINCT * FROM original`
- 填充：`UPDATE t SET col = COALESCE(col, default_val) WHERE col IS NULL`
- TRIM：`UPDATE t SET col = TRIM(col) WHERE col LIKE ' %' OR col LIKE '% '`
- 截断：`UPDATE t SET col = LEAST(col, {threshold}) WHERE col > {threshold}`

## 主动反问模板

当用户请求模糊时使用，对齐 `ask_clarification` 工具契约。

### 模板 1: 清洗范围不明

```yaml
question: "你想检查哪些数据质量问题？"
why: "不同场景关注的重点不同，全量检查耗时较长"
options:
  - id: full
    label: "全面检查（缺失 + 重复 + 异常 + 格式）"
    implied_assumption: "对整个表做全量质量检查，生成完整质量报告"
  - id: missing
    label: "只检查缺失值"
    implied_assumption: "用户主要关注数据完整性问题"
  - id: duplicate
    label: "只检查重复值"
    implied_assumption: "用户主要关注数据去重问题"
  - id: outlier
    label: "只检查异常值"
    implied_assumption: "用户主要关注数值异常问题"
default_if_skip: full
```

### 模板 2: 清洗策略不明

```yaml
question: "发现数据质量问题后，你希望怎么处理？"
why: "不同处理策略会影响后续分析结果"
options:
  - id: report_only
    label: "只报告问题，不执行清洗"
    implied_assumption: "用户只想了解数据质量状况，暂不修改数据"
  - id: auto_clean
    label: "自动执行常见清洗（去重 + TRIM + 填充 NULL）"
    implied_assumption: "对常见问题自动修复，保留原始表不变，结果写入新表"
  - id: interactive
    label: "逐项确认后再清洗"
    implied_assumption: "每个问题都需要用户确认处理方式后执行"
default_if_skip: report_only
```

### 模板 3: 缺失值填充策略不明

```yaml
question: "对于缺失值，你希望用什么方式填充？"
why: "不同填充策略适用于不同场景"
options:
  - id: median
    label: "用中位数填充（适用于数值列）"
    implied_assumption: "对数值列的 NULL 值用中位数填充，不受极端值影响"
  - id: mean
    label: "用均值填充（适用于数值列）"
    implied_assumption: "对数值列的 NULL 值用均值填充，保持总体均值不变"
  - id: mode
    label: "用众数填充（适用于分类列）"
    implied_assumption: "对分类列的 NULL 值用最频繁值填充"
  - id: drop
    label: "删除含 NULL 的行"
    implied_assumption: "删除任何包含 NULL 值的行，可能损失大量数据"
  - id: keep
    label: "保留 NULL 不处理"
    implied_assumption: "NULL 可能是有效业务含义（如'未知'），不做填充"
default_if_skip: median
```

## 常见失败场景与处理

### 场景 1: 表过大，全量检查超时

**表现**: 检查查询执行时间过长或超时。

**处理**:
1. 建议对数据采样（随机取 10000 条）做检查
2. 或逐列检查，避免一次性运行多个复杂查询
3. 告知用户采样检查可能遗漏低频问题

### 场景 2: 无法确定业务含义

**表现**: 无法判断某个值是否为异常（如年龄 150 可能是错误也可能是特殊编码）。

**处理**:
1. 向用户展示异常值及其上下文
2. 询问用户该值的业务含义
3. 让用户决定是否标记为异常

### 场景 3: 清洗 SQL 不安全

**表现**: transform_data 被安全检查拦截（如包含 DROP/DELETE）。

**处理**:
1. 不直接修改原表，改为 `CREATE TABLE clean AS SELECT ...`
2. 使用只读的 SELECT 查询生成清洗后的数据
3. 告知用户新表名和原始表的对应关系

## 示例对话

### 示例 1: 全面检查 → 质量报告

**用户**: "检查一下 iris 数据的质量"

**Agent**:
1. `describe_data` — 获取表结构和统计
2. 执行缺失值检查 → 结果：无 NULL
3. 执行重复值检查 → 结果：无重复
4. 执行异常值检查 → 结果：无 IQR 异常
5. 回复：数据质量良好，无缺失值、无重复行、无异常值

### 示例 2: 发现问题 → 反问 → 清洗

**用户**: "帮我清洗一下 users 表"

**Agent**: 触发 `ask_clarification`（模板 1: 清洗范围不明）

**用户**: 选择"全面检查"

**Agent**:
1. 检查发现：email 列有 5% NULL，name 列有 3% 前后空格，有 2 条完全重复行
2. 触发 `ask_clarification`（模板 2: 清洗策略不明）

**用户**: 选择"自动执行常见清洗"

**Agent**:
1. `transform_data` — TRIM name 列
2. `transform_data` — 去除完全重复行
3. 回复：清洗完成，2 条重复行已删除，name 列已 TRIM。email 的 NULL 值保留（需用户确认填充策略）
