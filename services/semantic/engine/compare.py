"""C8, the trusted-number check: does a result match the one the business trusts?

A port of DataDungeon's src/lib/grader/compare.ts (compareResultSets) with the same defaults: rows compared as a
multiset, column names case-insensitive and in any order, numbers within a relative tolerance of 1e-6.
"""
from __future__ import annotations

import datetime
import decimal
import math
import re


def _norm(v):
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)):
        return v.isoformat()
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (list, tuple)):
        return [_norm(x) for x in v]
    if isinstance(v, dict):
        return {k: _norm(x) for k, x in v.items()}
    return v if isinstance(v, (int, float, str)) else str(v)


def cell_eq(a, b, tol: float = 1e-6) -> bool:
    if a is None or b is None:
        return a is b
    num = lambda x: isinstance(x, (int, float)) and not isinstance(x, bool)
    if num(a) and num(b):
        if math.isnan(a) and math.isnan(b):
            return True
        return abs(a - b) <= tol * max(1, abs(a), abs(b))
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(cell_eq(x, y, tol) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return sorted(a) == sorted(b) and all(cell_eq(a[k], b[k], tol) for k in a)
    if isinstance(a, str) and isinstance(b, str):
        strip = lambda s: re.sub(r"T00:00:00(\.0+)?$", "", s).strip()
        return strip(a) == strip(b)
    return a == b


def compare(expected: dict, actual: dict, ordered: bool = False, tol: float = 1e-6) -> dict:
    """expected/actual: {columns: [...], rows: [[...]]}. Returns {pass, code, message}."""
    name = lambda s: s.lower().replace("`", "").strip()
    exp_cols, act_cols = [name(c) for c in expected["columns"]], [name(c) for c in actual["columns"]]
    missing = [c for c in exp_cols if c not in act_cols]
    if missing:
        return {"pass": False, "code": "MISSING_COLUMNS", "message": f"Missing column(s): {', '.join(missing)}."}
    extra = [c for c in act_cols if c not in exp_cols]
    if extra:
        return {"pass": False, "code": "EXTRA_COLUMNS", "message": f"Extra column(s): {', '.join(extra)}."}
    mapping = [act_cols.index(c) for c in exp_cols]
    E = [[_norm(v) for v in r] for r in expected["rows"]]
    A = [[_norm(r[i]) for i in mapping] for r in actual["rows"]]
    if len(E) != len(A):
        return {"pass": False, "code": "ROW_COUNT", "message": f"Expected {len(E)} row(s) but got {len(A)}."}
    if ordered:
        for i, (e, a) in enumerate(zip(E, A)):
            if not all(cell_eq(x, y, tol) for x, y in zip(e, a)):
                same = compare(expected, actual, ordered=False, tol=tol)["pass"]
                return {"pass": False, "code": "ORDER" if same else "VALUE_MISMATCH", "message": "Right rows, wrong order." if same else f"Row {i + 1} differs."}
        return {"pass": True, "code": "OK", "message": "Result matches."}
    left = list(A)
    for e in E:
        j = next((k for k, a in enumerate(left) if all(cell_eq(x, y, tol) for x, y in zip(e, a))), -1)
        if j < 0:
            return {"pass": False, "code": "VALUE_MISMATCH", "message": f"Some rows don't match. Expected a row like {e}."}
        left.pop(j)
    return {"pass": True, "code": "OK", "message": "Result matches."}
