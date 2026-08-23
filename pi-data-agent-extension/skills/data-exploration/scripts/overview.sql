-- Data Exploration Skill — Overview Script
--
-- 用法：运行时替换占位符 {table_name} 和 {column}
-- 示例：将 {table_name} 替换为 'iris'
--
-- 本脚本提供数据集的完整概览分析：
-- 1. 表结构（DESCRIBE）
-- 2. 总体统计（SUMMARIZE）
-- 3. 行数统计
-- 4. 各列 NULL 比例
-- 5. 分类列高频值 TOP 20
-- 6. 数值列分布分位数

-- ========================================
-- 1. 表结构
-- ========================================
DESCRIBE {table_name};

-- ========================================
-- 2. 总体统计（SUMMARIZE）
-- ========================================
SELECT * FROM (SUMMARIZE SELECT * FROM {table_name});

-- ========================================
-- 3. 行数统计
-- ========================================
SELECT COUNT(*) AS total_rows FROM {table_name};

-- ========================================
-- 4. 各列 NULL 比例
-- ========================================
SELECT
  column_name,
  null_count,
  total_count,
  ROUND(100.0 * null_count / total_count, 2) AS null_pct
FROM (
  SELECT
    UNNEST(columns) AS column_name,
    UNNEST([
      {%- for col in columns %}
      COUNT(CASE WHEN "{{ col }}" IS NULL THEN 1 END)
      {%- if not loop.last %},{% endif %}
      {%- endfor %}
    ]) AS null_count,
    COUNT(*) AS total_count
  FROM {table_name}
);

-- ========================================
-- 5. 分类列高频值 TOP 20
-- ========================================
-- 注：此查询需要对每个分类列单独执行
-- 运行时替换 {column} 为具体列名
SELECT
  {column},
  COUNT(*) AS freq,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS pct
FROM {table_name}
GROUP BY {column}
ORDER BY freq DESC
LIMIT 20;

-- ========================================
-- 6. 数值列分位数（25%, 50%, 75%）
-- ========================================
-- 注：此查询需要对每个数值列单独执行
-- 运行时替换 {column} 为具体列名
SELECT
  MIN({column}) AS min,
  APPROX_QUANTILE({column}, 0.25) AS q25,
  APPROX_QUANTILE({column}, 0.50) AS q50,
  APPROX_QUANTILE({column}, 0.75) AS q75,
  MAX({column}) AS max,
  AVG({column}) AS avg,
  STDDEV({column}) AS std
FROM {table_name};
