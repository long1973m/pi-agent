-- correlation.sql — 数值字段相关系数矩阵
--
-- 用途：计算多个数值字段之间的 Pearson 相关系数
-- 适用：了解字段间线性关联强度
-- 限制：只适用于数值列；相关性≠因果
--
-- 参数：
--   :cols   — 数值字段列表，逗号分隔（如 "amount, quantity, discount"）
--   :table  — 表名

WITH numeric_data AS (
  SELECT :cols FROM :table WHERE :cols IS NOT NULL
)
SELECT
  'correlation_matrix' AS analysis_type,
  -- 两两组合计算相关系数
  -- 注：DuckDB 的 CORR 需要两列，对于矩阵通常需要动态 SQL
  -- 以下模板展示核心计算逻辑，Agent 应根据实际字段数动态生成
  CORR(a, b) AS corr_coef
FROM (
  SELECT
    amount AS a,
    LAG(amount) OVER () AS b
  FROM :table
  LIMIT 1
);

-- 实用模板：两字段相关性（Agent 根据用户指定字段填充）
-- SELECT
--   CORR(:col_a, :col_b) AS correlation,
--   COUNT(*) AS sample_size
-- FROM :table;

-- 判断标准：
-- |correlation| > 0.7  → "强相关"
-- |correlation| > 0.3  → "中等相关"
-- |correlation| > 0.1  → "弱相关"
-- |correlation| <= 0.1 → "几乎无关"
