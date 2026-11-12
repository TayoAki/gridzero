"""Uploaded tables, queried with DuckDB.

The control service stages each workbook table as a CSV file and names it here. This module loads the files into an
in-memory DuckDB, then turns off every way out (other files, the network, extensions, settings) before running any
query, so SQL an agent wrote can read the staged tables and nothing else.
"""
from __future__ import annotations

import re

import duckdb

from engine import checks, draft, questions, scan as scanner

SAFE_NAME = re.compile(r"[^A-Za-z0-9_]+")


def table_name(name: str) -> str:
    """A table's name as SQL sees it: letters, digits and underscores, starting with a letter."""
    clean = SAFE_NAME.sub("_", name).strip("_") or "table"
    return clean if clean[0].isalpha() else "t_" + clean


NUMBER_TYPES = ("TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "FLOAT", "DOUBLE", "DECIMAL")
DATE_TYPES = ("DATE", "TIMESTAMP")


def column_kind(dtype: str) -> str:
    """A column's type in the three kinds a report filter knows: text, number or date."""
    t = dtype.upper()
    if t.startswith(DATE_TYPES):
        return "date"
    if t.startswith(NUMBER_TYPES):
        return "number"
    return "text"


def _columns(con: duckdb.DuckDBPyConnection, table: str) -> list[tuple[str, str]]:
    return [(r[0], column_kind(r[1])) for r in con.execute(f'DESCRIBE "{table}"').fetchall()]


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def apply_filters(con: duckdb.DuckDBPyConnection, tables: list[str], filters: list[dict]) -> list[dict]:
    """Drop the rows a report's filters leave out, in every table that has the filtered column.

    A filter is {field, values} for text, {field, range: [low, high]} for numbers, or {field, from, to} for
    dates (from is included, to is not). Values are bound, never written into the SQL. Returns which filter
    reached which table, so a card can say whether it followed.
    """
    applied: list[dict] = []
    for table in tables:
        columns = _columns(con, table)
        for f in filters:
            hit = next(((n, k) for n, k in columns if n.strip().lower() == str(f.get("field", "")).strip().lower()), None)
            if not hit:
                continue
            name, kind = hit
            col = _quote(name)
            if f.get("values"):
                marks = ", ".join("?" for _ in f["values"])
                con.execute(f'DELETE FROM "{table}" WHERE {col} IS NULL OR CAST({col} AS VARCHAR) NOT IN ({marks})', [str(v) for v in f["values"]])
            elif f.get("range") and kind == "number":
                con.execute(f'DELETE FROM "{table}" WHERE {col} IS NULL OR {col} < ? OR {col} > ?', [float(f["range"][0]), float(f["range"][1])])
            elif (f.get("from") or f.get("to")) and kind == "date":
                if f.get("from"):
                    con.execute(f'DELETE FROM "{table}" WHERE {col} IS NULL OR {col} < CAST(? AS TIMESTAMP)', [f["from"]])
                if f.get("to"):
                    con.execute(f'DELETE FROM "{table}" WHERE {col} IS NULL OR {col} >= CAST(? AS TIMESTAMP)', [f["to"]])
            else:
                continue
            applied.append({"field": f["field"], "table": table})
    return applied


def open_tables(files: list[dict], filters: list[dict] | None = None, applied: list[dict] | None = None) -> duckdb.DuckDBPyConnection:
    """files: [{name, path}]. Returns a connection holding one table per file and locked against everything else."""
    con = duckdb.connect(":memory:")
    con.execute("SET memory_limit = '1GB'")
    con.execute("SET threads = 2")
    for f in files:
        # The path is ours (a temp file the control service wrote); the table name is cleaned above.
        con.execute(f'CREATE TABLE "{table_name(f["name"])}" AS SELECT * FROM read_csv(?, header = true, sample_size = -1)', [f["path"]])
    if filters:
        done = apply_filters(con, [table_name(f["name"]) for f in files], filters)
        if applied is not None:
            applied.extend(done)
    con.execute("SET autoinstall_known_extensions = false")
    con.execute("SET autoload_known_extensions = false")
    con.execute("SET enable_external_access = false")
    con.execute("SET lock_configuration = true")
    return con


def _plain(v):
    return v if v is None or isinstance(v, (int, float, str, bool)) else str(v)


def query(job: dict) -> dict:
    """Run one read-only statement over the staged tables. Returns {columns, rows, truncated}."""
    applied: list[dict] = []
    con = open_tables(job["files"], job.get("filters"), applied)
    max_rows = int(job.get("max_rows", 500))
    cur = con.execute(job["sql"])
    columns = [d[0] for d in cur.description or []]
    rows = cur.fetchmany(max_rows + 1)
    # A filter counts for this query only when the query reads a table it reached.
    used = {a["field"] for a in applied if re.search(rf'(?<![A-Za-z0-9_]){re.escape(a["table"])}(?![A-Za-z0-9_])', job["sql"], re.I)}
    return {"columns": columns, "rows": [[_plain(v) for v in r] for r in rows[:max_rows]], "truncated": len(rows) > max_rows, "applied": sorted(used)}


MAX_VALUES = 200


def fields(job: dict) -> dict:
    """What a report over these tables can be filtered by, and the columns each given query returns.

    Per table: every column with its kind; for text its values when there are at most 200; for numbers and
    dates its lowest and highest. `describe` is a list of {id, sql}: the answer gives each one's column names
    without running it, or null when it does not parse.
    """
    con = open_tables(job["files"], job.get("filters"))
    out = []
    for f in job["files"]:
        table = table_name(f["name"])
        cols = []
        for name, kind in _columns(con, table):
            col = _quote(name)
            entry: dict = {"name": name, "kind": kind}
            if kind == "text":
                values = [r[0] for r in con.execute(f'SELECT DISTINCT CAST({col} AS VARCHAR) FROM "{table}" WHERE {col} IS NOT NULL ORDER BY 1 LIMIT {MAX_VALUES + 1}').fetchall()]
                entry["values"] = values if len(values) <= MAX_VALUES else None
            else:
                low, high = con.execute(f'SELECT MIN({col}), MAX({col}) FROM "{table}"').fetchone()
                entry["min"], entry["max"] = _plain(low), _plain(high)
            cols.append(entry)
        out.append({"table": table, "rows": con.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0], "columns": cols})
    described = {}
    for d in job.get("describe") or []:
        try:
            described[d["id"]] = {
                "columns": [r[0] for r in con.execute(f'DESCRIBE {d["sql"]}').fetchall()],
                "tables": [t["table"] for t in out if re.search(rf'(?<![A-Za-z0-9_]){re.escape(t["table"])}(?![A-Za-z0-9_])', d["sql"], re.I)],
            }
        except Exception:
            described[d["id"]] = None
    return {"tables": out, "described": described}


def analyse(job: dict) -> dict:
    """Scan the staged tables, draft definitions and raise questions: the same pipeline as a database source."""
    con = open_tables(job["files"])
    run = lambda sql: con.execute(sql).fetchall()
    sc = scanner.scan(run, dialect="duckdb")
    definitions = draft.draft(sc, None, suggest_basics=True)
    findings = checks.grain_findings(sc["tables"])
    qs = questions.build_questions(sc, findings, definitions, limit=int(job.get("question_limit", 10)))
    return {"scan": sc, "definitions": definitions, "questions": qs, "findings": findings,
            "history": {"statements": 0, "unparsed": 0, "joins": 0, "named_totals": 0}}
