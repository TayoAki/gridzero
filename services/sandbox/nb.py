"""What a notebook's Python cell can use.

    from nb import sql, table, tables, save

tables()        the names of the workbook's tables
table("orders") one table, as a DuckDB relation (call .df() for pandas, .fetchall() for rows)
sql("select …") any query over those tables, as a DuckDB relation
save("scores", data)  keep a result: a relation, a pandas or polars frame, or a list of dicts.
                      It shows under the cell; a notebook run on a schedule writes it into the workbook.

The tables are copies made when the cell started. Nothing here can reach the network or any file
outside the cell's own folder.
"""

import csv
import os

import duckdb

_dir = os.environ["SANDBOX_WORK_DIR"]
_con = duckdb.connect()
_names = []
for _f in sorted(os.listdir(os.path.join(_dir, "tables"))) if os.path.isdir(os.path.join(_dir, "tables")) else []:
    if _f.endswith(".csv"):
        _name = _f[:-4]
        _path = os.path.join(_dir, "tables", _f).replace("'", "''")
        _con.execute(f'CREATE VIEW "{_name.replace(chr(34), chr(34) * 2)}" AS SELECT * FROM read_csv_auto(\'{_path}\', header=true)')
        _names.append(_name)

MAX_ROWS = 200_000
MAX_SAVED = 5
_saved = 0


def tables():
    return list(_names)


def table(name):
    if name not in _names:
        raise KeyError(f"There is no table called {name}. The tables are: {', '.join(_names) or 'none'}")
    return _con.table(name)


def sql(query):
    return _con.sql(query)


def save(name, data):
    """Keep a result under a name of letters, digits and underscores."""
    global _saved
    if not name or not all(ch.isalnum() or ch == "_" for ch in name) or len(name) > 60:
        raise ValueError("A saved table's name is up to 60 letters, digits and underscores")
    if _saved >= MAX_SAVED:
        raise ValueError(f"A run can save {MAX_SAVED} tables")
    if hasattr(data, "fetchall") and hasattr(data, "columns"):
        columns, rows = list(data.columns), data.fetchall()
    elif hasattr(data, "to_dict") and hasattr(data, "columns"):  # pandas
        columns, rows = [str(c) for c in data.columns], data.itertuples(index=False, name=None)
    elif hasattr(data, "rows") and hasattr(data, "columns"):  # polars
        columns, rows = list(data.columns), data.rows()
    elif isinstance(data, list) and data and isinstance(data[0], dict):
        columns = list(data[0].keys())
        rows = [[r.get(c) for c in columns] for r in data]
    else:
        raise TypeError("save() takes a DuckDB relation, a pandas or polars frame, or a list of dicts")
    os.makedirs(os.path.join(_dir, "out"), exist_ok=True)
    count = 0
    with open(os.path.join(_dir, "out", name + ".csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(columns)
        for r in rows:
            count += 1
            if count > MAX_ROWS:
                raise ValueError(f"A saved table holds up to {MAX_ROWS:,} rows")
            w.writerow(["" if v is None else v for v in r])
    _saved += 1
    print(f"Saved {name}: {count:,} rows, {len(columns)} columns")
