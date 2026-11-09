"""The workbook from Python (BUILD-SPEC §5.4). Each call is one workbook action.

Reading works everywhere. Changing the workbook works from a Run by an editor, not
from custom functions or from "execute on wake".
"""

import os
import re
import uuid
from dataclasses import dataclass

import _gridzero_runner as _runner

WORK_DIR = os.environ.get("SANDBOX_WORK_DIR", "/wb")


@dataclass(frozen=True)
class Sheet:
    id: int
    name: str


@dataclass(frozen=True)
class Range:
    sheet: Sheet
    r0: int
    c0: int
    r1: int
    c1: int

    def _wire(self):
        return {"sheet": self.sheet.id, "r0": self.r0, "c0": self.c0, "r1": self.r1, "c1": self.c1}


def _action(action):
    return _runner.rpc({"op": "action", "action": action})


def sheet(id_or_name):
    """A sheet by name or by 0-based position."""
    sheets = _runner.rpc({"op": "sheets"})
    for i, s in enumerate(sheets):
        if id_or_name == i or (isinstance(id_or_name, str) and s["name"].lower() == id_or_name.lower()):
            return Sheet(i, s["name"])
    raise KeyError(f"No sheet called {id_or_name!r}")


def _column(letters):
    n = 0
    for ch in letters.upper():
        n = n * 26 + ord(ch) - 64
    return n - 1


def sheet_range(s, ref):
    """A range such as "A1:B10" on a sheet."""
    m = re.fullmatch(r"([A-Za-z]{1,3})([0-9]+)(?::([A-Za-z]{1,3})([0-9]+))?", ref)
    if not m:
        raise ValueError(f"{ref!r} is not a cell or range like A1:B10")
    c0, r0 = _column(m[1]), int(m[2]) - 1
    c1, r1 = (_column(m[3]), int(m[4]) - 1) if m[3] else (c0, r0)
    return Range(s, min(r0, r1), min(c0, c1), max(r0, r1), max(c0, c1))


def get_values(r):
    """The cells of a range as rows of displayed values."""
    return _runner.rpc({"op": "values", "range": r._wire()})


def get_table(table):
    """A Data Table (by name or id), as filtered and sorted in the sheet."""
    import polars

    return polars.read_parquet(os.path.join(WORK_DIR, _runner.rpc({"op": "table", "table": table})))


def update_cell(s, ref, raw):
    r = sheet_range(s, ref)
    _action({"type": "UpdateCell", "sheet": s.id, "row": r.r0, "col": r.c0, "raw": str(raw)})


def update_range(r, values):
    """Write rows of values starting at the range's top-left cell."""
    text = "\n".join("\t".join("" if v is None else str(v) for v in row) for row in values)
    _action({"type": "PasteText", "sheet": r.sheet.id, "row": r.r0, "col": r.c0, "text": text})


def fill_range(src, dst):
    _action({"type": "Fill", "source": src._wire(), "to_row": dst.r1 if dst.r1 != src.r1 else None, "to_col": dst.c1 if dst.c1 != src.c1 else None})


def clear_range(r):
    _action({"type": "ClearRange", "range": r._wire(), "formats": False})


def create_chart(dest, kind, y, x=None, title=None):
    series = [{"range": s._wire(), "name": None, "kind": None, "axis": "Left"} for s in y]
    spec = {"id": "", "sheet": dest.sheet.id, "row": dest.r0, "col": dest.c0, "w": 520, "h": 320, "kind": kind, "title": title or "", "x": x._wire() if x else None, "series": series, "bins": None, "stacked": False}
    return _action({"type": "CreateChart", "spec": spec})


_AGGS = {"sum": "Sum", "count": "Count", "unique": "CountUnique", "avg": "Avg", "average": "Avg", "min": "Min", "max": "Max", "median": "Median"}


def _source(target):
    if isinstance(target, Range):
        return {"type": "Range", "range": target._wire()}
    return {"type": "Table", "table": target}


def create_pivot(source, dest, rows=(), columns=(), values=(), filters=()):
    new_sheet = dest == "new_sheet"
    spec = {
        "id": "",
        "sheet": 0 if new_sheet else dest.sheet.id,
        "row": 0 if new_sheet else dest.r0,
        "col": 0 if new_sheet else dest.c0,
        "source": _source(source),
        "rows": [{"field": f, "group": None} for f in rows],
        "columns": [{"field": f, "group": None} for f in columns],
        "values": [{"field": f, "agg": _AGGS[a.lower()], "percentile": None} for f, a in values],
        "filters": list(filters),
        "totals": True,
    }
    return _action({"type": "CreatePivot", "spec": spec, "new_sheet": new_sheet})


def create_slicer(target, column, dest=None):
    s = dest or (target if isinstance(target, Range) else None)
    spec = {"id": "", "sheet": s.sheet.id if s else 0, "row": s.r0 if s else 0, "col": (s.c1 + 2) if s else 0, "target": _source(target), "column": column, "title": ""}
    return _action({"type": "CreateSlicer", "spec": spec})


def write_dataframe(df, dest, as_table=True, name="data"):
    """Put a polars DataFrame on the sheet, as a Data Table or as plain cells."""
    file = f"out_{uuid.uuid4().hex}.parquet"
    df.write_parquet(os.path.join(WORK_DIR, file))
    return _runner.rpc({"op": "import", "file": file, "sheet": dest.sheet.id, "row": dest.r0, "col": dest.c0, "as_table": as_table, "name": name})


def run_query(connection_name, sql, dest):
    raise NotImplementedError("run_query needs connections, which are not available from Python yet")
