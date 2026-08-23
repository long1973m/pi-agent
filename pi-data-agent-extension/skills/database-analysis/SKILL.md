---
name: database-analysis
version: "1.0.0"
priority: 8
description: |
  数据库概览分析 Skill — 帮助用户快速了解已加载数据的全貌。
  适用于"数据里有什么"、"有哪些表"、"表结构怎么样"、"数据质量如何"等请求。
  只做概览展示，不做复杂性能诊断或索引优化。
tags: ["database", "overview", "schema", "data-quality"]
requires:
  - list_datasets
  - describe_data
  - query_data
scripts:
  db-overview: ./scripts/db-overview.sql
---

# Database Analysis Skill

## 触发条件

当用户出现以下意图时，优先使用本 Skill：

- "数据里有什么" / "有哪些表" / "数据集概况"
- "表结构怎么样" / "字段有哪些" / "列信息"
- "数据质量如何" / "有没有空值" / "数据完整性"
- "数据库概览" / "整体情况"

## 适用场景

| 场景 | 方法 | 输出 |
|------|------|------|
| 了解有哪些数据集 | `list_datasets` | 表名、行数、列数、来源 |
| 了解单表结构 | `describe_data` | 字段名、类型、语义、统计摘要 |
| 了解数据质量 | SQL 查询 | 空值率、重复率、唯一值数 |
| 了解数值分布 | SQL 查询 | 最小值、最大值、均值、中位数 |

## 不适用场景（明确边界）

| 需求 | 原因 | 回应方式 |
|------|------|----------|
| 索引优化建议 | 需要了解查询模式和性能指标 | "当前版本不做性能诊断" |
| 数据库迁移方案 | 需要 schema 对比和迁移工具 | "超出当前 Agent 能力范围" |
| 权限审计 | 需要数据库用户和权限信息 | "当前不做权限分析" |
| 数据血缘追踪 | 需要 ETL 管道元数据 | "超出当前范围" |

## 执行策略

### Phase 1: 意图识别

1. 判断用户是想要"整体概览"还是"单表详情"
2. 模糊时触发 `ask_clarification`

### Phase 2: 方法执行

**整体概览**：
1. 调用 `list_datasets` 获取所有表
2. 如果表数量少（< 5），逐个调用 `describe_data` 获取结构
3. 汇总输出表列表 + 关键指标

**数据质量检查**：
1. 确认目标表
2. 使用 `scripts/db-overview.sql` 查询：
   - 总行数
   - 各字段空值率
   - 重复行数
   - 数值字段分布

### Phase 3: 结果解释

向用户说明：
- 数据集数量和大致规模
- 关键字段和类型
- 明显的数据质量问题（高缺失率、异常分布）
- 建议下一步分析方向

## 主动反问模板

当用户说"看看数据"、"分析一下数据库"但未指定范围时：

```yaml
question: "你想了解哪个层面的信息？"
why: "数据库分析有不同粒度，需要明确范围"
options:
  - id: overview
    label: "整体概览：有多少表、多少数据"
    implied_assumption: "用户想了解数据集的宏观情况"
  - id: table_detail
    label: "单表详情：某张表的字段结构和统计"
    implied_assumption: "用户想深入了解特定表"
  - id: quality
    label: "数据质量：空值、重复、异常分布"
    implied_assumption: "用户关心数据质量"
default_if_skip: overview
```

## SQL 模板引用

| 分析类型 | SQL 模板 | 说明 |
|---------|---------|------|
| 数据库概览 | `scripts/db-overview.sql` | 表列表、行数、字段数、空值率 |

## 示例对话

**用户**: "数据里有什么？"

**Agent**:
1. `list_datasets()`
2. 汇总输出："共 X 张表，总计 Y 行"
3. 列出每张表的字段数和主要字段
4. 提示："用 describe_data('表名') 查看详情"
