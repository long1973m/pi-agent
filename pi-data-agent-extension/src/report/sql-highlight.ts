/**
 * Task 1 — SQL 提取与轻量语法高亮
 *
 * 纯字符串正则 tokenizer，零外部依赖（红线 R5）。
 * 支持：关键字 / 字符串 / 数字 / 注释 的 token 级着色。
 */

/** SQL 关键字列表 */
const SQL_KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "IS", "IN",
  "EXISTS", "BETWEEN", "LIKE", "ILIKE", "GLOB", "MATCH", "REGEXP",
  "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE",
  "CREATE", "DROP", "ALTER", "TABLE", "INDEX", "VIEW", "TRIGGER",
  "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "NATURAL",
  "ON", "USING",
  "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET",
  "UNION", "INTERSECT", "EXCEPT", "ALL", "DISTINCT",
  "WITH", "AS", "RECURSIVE",
  "CASE", "WHEN", "THEN", "ELSE", "END",
  "ASC", "DESC",
  "TRUE", "FALSE",
  "CAST", "COALESCE", "IFNULL", "NULLIF", "COUNT", "SUM", "AVG", "MIN", "MAX",
  "PRAGMA", "VACUUM", "ANALYZE", "EXPLAIN",
]);

/** Token 类型 */
type TokenType = "keyword" | "string" | "number" | "comment" | "identifier" | "operator" | "whitespace" | "other";

interface Token {
  type: TokenType;
  text: string;
}

/**
 * 将 SQL 字符串 tokenize 并转为 HTML
 *
 * @param sql - 原始 SQL 字符串
 * @returns HTML 字符串（含 <span class="sql-*"> 标签）
 */
export function highlightSql(sql: string): string {
  const tokens = tokenize(sql);
  return tokens.map(renderToken).join("");
}

/**
 * 获取 SQL 的前 N 行（用于默认折叠展示）
 */
export function getFirstLines(sql: string, n: number = 3): string {
  return sql.split("\n").slice(0, n).join("\n");
}

/**
 * 检查 SQL 是否超过 N 行
 */
export function exceedsLines(sql: string, n: number = 3): boolean {
  return sql.split("\n").length > n;
}

// ============================================================================
// Tokenizer
// ============================================================================

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  while (pos < sql.length) {
    const ch = sql[pos];
    const rest = sql.slice(pos);

    // 1. 块注释 /* ... */
    if (ch === "/" && sql[pos + 1] === "*") {
      const end = sql.indexOf("*/", pos + 2);
      if (end !== -1) {
        tokens.push({ type: "comment", text: sql.slice(pos, end + 2) });
        pos = end + 2;
        continue;
      }
    }

    // 2. 行注释 -- ...
    if (ch === "-" && sql[pos + 1] === "-") {
      const end = sql.indexOf("\n", pos);
      if (end !== -1) {
        tokens.push({ type: "comment", text: sql.slice(pos, end) });
        pos = end;
        continue;
      } else {
        tokens.push({ type: "comment", text: sql.slice(pos) });
        break;
      }
    }

    // 3. 单引号字符串
    if (ch === "'") {
      const result = parseQuotedString(sql, pos, "'");
      tokens.push({ type: "string", text: result.str });
      pos = result.nextPos;
      continue;
    }

    // 4. 双引号标识符 / 字符串
    if (ch === '"') {
      const result = parseQuotedString(sql, pos, '"');
      tokens.push({ type: "string", text: result.str });
      pos = result.nextPos;
      continue;
    }

    // 5. 反引号标识符
    if (ch === "`") {
      const result = parseQuotedString(sql, pos, "`");
      tokens.push({ type: "identifier", text: result.str });
      pos = result.nextPos;
      continue;
    }

    // 6. 数字（整数、浮点数、科学计数法）
    const numMatch = rest.match(/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numMatch) {
      tokens.push({ type: "number", text: numMatch[0] });
      pos += numMatch[0].length;
      continue;
    }

    // 7. 标识符 / 关键字
    const idMatch = rest.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
    if (idMatch) {
      const word = idMatch[0];
      const upper = word.toUpperCase();
      const type = SQL_KEYWORDS.has(upper) ? "keyword" : "identifier";
      tokens.push({ type, text: word });
      pos += word.length;
      continue;
    }

    // 8. 空白符
    const wsMatch = rest.match(/^\s+/);
    if (wsMatch) {
      tokens.push({ type: "whitespace", text: wsMatch[0] });
      pos += wsMatch[0].length;
      continue;
    }

    // 9. 操作符（>=, <=, !=, <>, || 等多字符）
    const op2 = rest.match(/^(>=|<=|!=|<>|\|\||->>|->|::)/);
    if (op2) {
      tokens.push({ type: "operator", text: op2[0] });
      pos += op2[0].length;
      continue;
    }

    // 单字符操作符 / 标点
    if (/[+\-*/%=<>!&|^~,;()]/.test(ch)) {
      tokens.push({ type: "operator", text: ch });
      pos++;
      continue;
    }

    // 10. 其他（兜底）
    tokens.push({ type: "other", text: ch });
    pos++;
  }

  return tokens;
}

/**
 * 解析带转义的引号字符串
 */
function parseQuotedString(sql: string, start: number, quote: string): { str: string; nextPos: number } {
  let pos = start + 1;
  let result = quote;

  while (pos < sql.length) {
    const ch = sql[pos];
    if (ch === quote) {
      // 检查是否是转义（双引号 = 转义）
      if (sql[pos + 1] === quote) {
        result += quote + quote;
        pos += 2;
      } else {
        result += quote;
        pos++;
        break;
      }
    } else if (ch === "\\") {
      result += ch + (sql[pos + 1] ?? "");
      pos += 2;
    } else {
      result += ch;
      pos++;
    }
  }

  return { str: result, nextPos: pos };
}

// ============================================================================
// HTML 渲染
// ============================================================================

function renderToken(token: Token): string {
  const esc = escapeHtml(token.text);
  switch (token.type) {
    case "keyword":
      return `<span class="sql-kw">${esc}</span>`;
    case "string":
      return `<span class="sql-str">${esc}</span>`;
    case "number":
      return `<span class="sql-num">${esc}</span>`;
    case "comment":
      return `<span class="sql-cmt">${esc}</span>`;
    case "operator":
      return `<span class="sql-op">${esc}</span>`;
    case "identifier":
      return `<span class="sql-id">${esc}</span>`;
    case "whitespace":
      // 保留换行，空格转普通空格
      return esc.replace(/\n/g, "\n").replace(/ /g, " ").replace(/\t/g, "  ");
    default:
      return esc;
  }
}

function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
