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


def open_tables(files: list[dict]) -> duckdb.DuckDBPyConnection:
    """files: [{name, path}]. Returns a connection holding one table per file and locked against everything else."""
    con = duckdb.connect(":memory:")
    con.execute("SET memory_limit = '1GB'")
    con.execute("SET threads = 2")
    for f in files:
        # The path is ours (a temp file the control service wrote); the table name is cleaned above.
        con.execute(f'CREATE TABLE "{table_name(f["name"])}" AS SELECT * FROM read_csv(?, header = true, sample_size = -1)', [f["path"]])
    con.execute("SET autoinstall_known_extensions = false")
    con.execute("SET autoload_known_extensions = false")
    con.execute("SET enable_external_access = false")
    con.execute("SET lock_configuration = true")
    return con


def _plain(v):
    return v if v is None or isinstance(v, (int, float, str, bool)) else str(v)


def query(job: dict) -> dict:
    """Run one read-only statement over the staged tables. Returns {columns, rows, truncated}."""
    con = open_tables(job["files"])
    max_rows = int(job.get("max_rows", 500))
    cur = con.execute(job["sql"])
    columns = [d[0] for d in cur.description or []]
    rows = cur.fetchmany(max_rows + 1)
    return {"columns": columns, "rows": [[_plain(v) for v in r] for r in rows[:max_rows]], "truncated": len(rows) > max_rows}


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
