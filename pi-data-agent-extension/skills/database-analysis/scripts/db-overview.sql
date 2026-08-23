-- db-overview.sql — 数据库概览与数据质量检查
--
-- 用途：快速了解表的数据质量（空值率、重复率、行数、字段类型）
-- 适用：数据加载后的首次质量检查
--
-- 参数：
--   :table  — 表名

-- 1. 总行数
SELECT COUNT(*) AS total_rows FROM :table;

-- 2. 各字段空值率（动态生成，Agent 根据实际字段构造 UNION ALL）
-- 示例（需 Agent 根据 describe_data 结果动态生成）：
-- SELECT 'field_name' AS column_name,
--        COUNT(*) FILTER (WHERE field_name IS NULL) * 100.0 / COUNT(*) AS null_pct
-- FROM :table;

-- 3. 完全重复行数
-- SELECT total_rows - COUNT(DISTINCT *) AS duplicate_rows FROM :table;

-- 4. 数值字段分布（动态生成）
-- SELECT MIN(num_field), MAX(num_field), AVG(num_field), MEDIAN(num_field)
-- FROM :table;
