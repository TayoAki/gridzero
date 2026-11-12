"""Delta Lake tables (the open table format, via the delta-rs library). Three jobs:

write    put rows into a Delta table; each write is a new version, and old versions stay readable
history  the table's versions and when each was written
diff     what changed between two versions, matched on a key column: rows added, removed and changed

Every value is stored as text: these tables record what was shown or typed, and are compared, not computed on.
"""

import os

import pyarrow as pa
from deltalake import DeltaTable, write_deltalake

LIMIT = 500


def _rows(path: str, version: int | None):
    t = DeltaTable(path, version=version) if version is not None else DeltaTable(path)
    return t.to_pyarrow_table().to_pylist()


def write(job: dict) -> dict:
    cols = [str(c) for c in job["columns"]]
    data = {c: pa.array([None if r[i] is None else str(r[i]) for r in job["rows"]], type=pa.string()) for i, c in enumerate(cols)}
    os.makedirs(os.path.dirname(job["path"]), exist_ok=True)
    write_deltalake(job["path"], pa.table(data), mode="overwrite", schema_mode="overwrite")
    t = DeltaTable(job["path"])
    return {"version": t.version(), "rows": len(job["rows"])}


def history(job: dict) -> dict:
    if not os.path.isdir(os.path.join(job["path"], "_delta_log")):
        return {"versions": []}
    t = DeltaTable(job["path"])
    return {"versions": [{"version": h.get("version"), "at": h.get("timestamp")} for h in t.history()]}


def diff(job: dict) -> dict:
    key = job["key"]
    a = {str(r.get(key)): r for r in _rows(job["path"], int(job["a"]))}
    b = {str(r.get(key)): r for r in _rows(job["path"], int(job["b"]))}
    added = [b[k] for k in b if k not in a]
    removed = [a[k] for k in a if k not in b]
    changed = []
    for k in b:
        if k in a and a[k] != b[k]:
            was = {c: a[k].get(c) for c in b[k] if a[k].get(c) != b[k].get(c)}
            changed.append({"key": k, "was": was, "now": {c: b[k].get(c) for c in was}})
    return {"key": key, "rows_before": len(a), "rows_after": len(b), "added": added[:LIMIT], "removed": removed[:LIMIT], "changed": changed[:LIMIT], "counts": {"added": len(added), "removed": len(removed), "changed": len(changed)}}
