# Semantic engine

Python, sqlglot. The part of confirmed definitions (docs/specs/DEFINITIONS-SPEC.md) that reads SQL and data shapes:
what to scan, keys and links, what people wrote in query history, the checks, the draft and the questions.

It holds no credentials and opens no connections. The control service starts `worker.py` for one job, runs every
query the worker asks for as the person who started the job, and reads the result (see the top of `worker.py`).

`engine/` is the same code that was scored on DataDungeon's lesson data before this was built
(DataDungeon `research/semantic-inference/REPORT.md`). Keep the two copies the same.

Needs Python 3.10+ and `pip install -r requirements.txt`. The control service finds Python through
`SEMANTIC_PYTHON` (default `python3`).
