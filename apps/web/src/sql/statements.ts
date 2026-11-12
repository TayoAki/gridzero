// SQL-text helpers for the SQL editor: splitting a script into statements (for "run the one the cursor is in"
// and for error lines) and a small formatter. Lifted from DataDungeon's warehouse workspace
// (src/components/snowflake/sql.ts), by the same author. Pure functions: no React, no engine.

export interface Statement {
  /** Statement text without the trailing semicolon. */
  text: string;
  /** Offset of the first non-blank character. */
  from: number;
  /** Offset just past the statement (including its semicolon, when there is one). */
  to: number;
}

/**
 * Split SQL into statements on top-level semicolons, skipping semicolons inside '…' strings, "…" identifiers,
 * $$…$$ bodies and -- // /* comments. Blank and comment-only pieces are dropped.
 */
export function splitStatements(code: string): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  const n = code.length;
  const push = (end: number, to: number) => {
    const raw = code.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    if (stripComments(raw).trim()) out.push({ text: raw.trim(), from: start + lead, to });
  };
  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    if (c === "-" && d === "-") i = lineEnd(code, i);
    else if (c === "/" && d === "/") i = lineEnd(code, i);
    else if (c === "/" && d === "*") {
      const e = code.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === "$" && d === "$") {
      const e = code.indexOf("$$", i + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === "'" || c === '"') {
      i++;
      while (i < n) {
        if (c === "'" && code[i] === "\\") i += 2;
        else if (code[i] === c && code[i + 1] === c) i += 2;
        else if (code[i] === c) {
          i++;
          break;
        } else i++;
      }
    } else if (c === ";") {
      push(i, i + 1);
      start = i + 1;
      i++;
    } else i++;
  }
  push(n, n);
  return out;
}

function lineEnd(code: string, i: number) {
  const e = code.indexOf("\n", i);
  return e < 0 ? code.length : e;
}

/** Remove comments (keeps strings), used to tell comment-only pieces from statements. */
export function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
}

/** The statement the cursor is in; between statements, the one before the cursor (else the next one). */
export function statementAt(code: string, pos: number): Statement | null {
  const all = splitStatements(code);
  if (!all.length) return null;
  const inside = all.find((s) => pos >= s.from && pos <= s.to);
  if (inside) return inside;
  const before = all.filter((s) => s.to <= pos);
  return before.length ? before[before.length - 1] : all[0];
}

/** 1-based line number of an offset. */
export function lineOf(code: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < code.length; i++) if (code[i] === "\n") line++;
  return line;
}

/* ------------------------------------------------------------------ formatter */

const CLAUSES = [
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP BY",
  "HAVING",
  "QUALIFY",
  "ORDER BY",
  "LIMIT",
  "UNION ALL",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "LEFT OUTER JOIN",
  "RIGHT OUTER JOIN",
  "FULL OUTER JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "FULL JOIN",
  "INNER JOIN",
  "CROSS JOIN",
  "JOIN",
  "VALUES",
  "SET",
  "WHEN MATCHED",
  "WHEN NOT MATCHED",
  "WITH",
];

const KEYWORDS = new Set(
  (
    "select from where group by having qualify order limit offset union all except intersect join left right full outer inner cross on using as and or not in is null like ilike between case when then else end distinct with insert into values update set delete merge matched create replace table view database schema warehouse role grant revoke use show describe drop alter if exists asc desc nulls first last over partition rows range unbounded preceding following current row true false lateral flatten cast try_cast copy stage file format transient temporary secure clone undrop swap at before"
  ).split(" "),
);

/**
 * Light SQL formatter: one clause per line, select-list items one per line, keywords upper case. Strings, quoted
 * identifiers and comments are left exactly as written.
 */
export function formatSql(code: string): string {
  const stmts = splitStatements(code);
  if (!stmts.length) return code;
  return stmts.map((s) => formatStatement(s.text) + ";").join("\n\n") + "\n";
}

type Tok = { t: "word" | "str" | "comment" | "punct" | "space"; v: string };

function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const d = sql[i + 1];
    if (/\s/.test(c)) {
      let j = i;
      while (j < sql.length && /\s/.test(sql[j])) j++;
      out.push({ t: "space", v: sql.slice(i, j) });
      i = j;
    } else if ((c === "-" && d === "-") || (c === "/" && d === "/")) {
      const e = lineEnd(sql, i);
      out.push({ t: "comment", v: sql.slice(i, e) });
      i = e;
    } else if (c === "/" && d === "*") {
      const e = sql.indexOf("*/", i + 2);
      const end = e < 0 ? sql.length : e + 2;
      out.push({ t: "comment", v: sql.slice(i, end) });
      i = end;
    } else if (c === "$" && d === "$") {
      const e = sql.indexOf("$$", i + 2);
      const end = e < 0 ? sql.length : e + 2;
      out.push({ t: "str", v: sql.slice(i, end) });
      i = end;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (c === "'" && sql[j] === "\\") j += 2;
        else if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) {
          j++;
          break;
        } else j++;
      }
      out.push({ t: "str", v: sql.slice(i, j) });
      i = j;
    } else if (/[A-Za-z0-9_$@.:]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_$@.:]/.test(sql[j])) j++;
      out.push({ t: "word", v: sql.slice(i, j) });
      i = j;
    } else {
      out.push({ t: "punct", v: c });
      i++;
    }
  }
  return out;
}

const upperKeyword = (t: Tok): Tok => (t.t === "word" && KEYWORDS.has(t.v.toLowerCase()) ? { t: "word", v: t.v.toUpperCase() } : t);

function formatStatement(sql: string): string {
  // Comments before the statement stay as written, one per line.
  let lead = "";
  let rest = sql;
  for (;;) {
    const m = /^\s*(--[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*/.exec(rest);
    if (!m) break;
    lead += m[1].trimEnd() + "\n";
    rest = rest.slice(m[0].length);
  }
  const toks = tokenize(rest);
  // Comments inside the statement: only upper-case keywords, keep the layout (moving lines could comment out code).
  if (toks.some((t) => t.t === "comment")) return lead + toks.map((t) => upperKeyword(t).v).join("");
  // Collapse whitespace to single spaces, upper-case keywords.
  const words: Tok[] = [];
  for (const t of toks) {
    if (t.t === "space") {
      if (words.length && words[words.length - 1].t !== "space") words.push({ t: "space", v: " " });
    } else words.push(upperKeyword(t));
  }
  let out = "";
  let depth = 0;
  let inSelect = false;
  const ahead = (i: number, phrase: string) => {
    const parts = phrase.split(" ");
    let k = i;
    for (const p of parts) {
      while (words[k]?.t === "space") k++;
      if (words[k]?.t !== "word" || words[k].v.toUpperCase() !== p) return 0;
      k++;
    }
    return k;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.t === "punct" && w.v === "(") depth++;
    if (w.t === "punct" && w.v === ")") depth = Math.max(0, depth - 1);
    if (w.t === "word" && depth === 0) {
      const clause = CLAUSES.find((c) => ahead(i, c));
      if (clause) {
        const end = ahead(i, clause);
        out = out.trimEnd();
        if (out) out += "\n";
        out += clause;
        inSelect = clause === "SELECT";
        i = end - 1;
        if (inSelect) {
          // keep DISTINCT on the SELECT line
          let k = end;
          while (words[k]?.t === "space") k++;
          if (words[k]?.t === "word" && words[k].v === "DISTINCT") {
            out += " DISTINCT";
            i = k;
          }
          out += "\n  ";
        } else out += " ";
        continue;
      }
    }
    if (w.t === "space") {
      if (!out.endsWith(" ") && !out.endsWith("\n  ") && !out.endsWith("\n")) out += " ";
      continue;
    }
    if (w.t === "punct" && w.v === "," && depth === 0 && inSelect) {
      out = out.trimEnd() + ",\n  ";
      let k = i + 1;
      while (words[k]?.t === "space") k++;
      i = k - 1;
      continue;
    }
    if (w.t === "punct" && (w.v === "," || w.v === ")")) out = out.trimEnd();
    out += w.v;
    if (w.t === "punct" && w.v === "(") {
      let k = i + 1;
      while (words[k]?.t === "space") k++;
      i = k - 1;
    }
  }
  return lead + out.trim();
}

/* ------------------------------------------------------------------ editor dialect */
