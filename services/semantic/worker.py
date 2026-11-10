"""The semantic engine as a worker for the control service.

One job per process. The control service writes one JSON request on stdin; the worker answers with JSON lines on
stdout. When it needs a query run it writes {"need": "<sql>"} and waits for {"rows": [[...]]} or {"error": "..."} on
stdin: the control service runs the SQL as the person who asked, so this process never sees a credential or opens a
connection. The last line is {"result": ...} or {"error": "..."}.

Jobs:
  analyse  {dialect, schemas?, statements: [{sql, user?}]}  -> {scan, definitions, questions, findings, history}
  lint     {dialect, sql, scan}                             -> {findings}
  resolve  {dialect, expression, scan}                      -> {ok, expression?, tables?, aggregate?, error?}
"""
from __future__ import annotations

import json
import sys

from engine import checks, draft, history, questions, scan as scanner

MAX_LINTED = 60


def send(obj) -> None:
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def run(sql: str) -> list:
    send({"need": sql})
    reply = json.loads(sys.stdin.readline())
    if "error" in reply:
        raise RuntimeError(reply["error"])
    return reply["rows"]


def analyse(job: dict) -> dict:
    dialect = job.get("dialect", "postgres")
    sc = scanner.scan(run, schemas=job.get("schemas") or None, dialect=dialect, max_rows=int(job.get("max_rows", 1_000_000)))
    statements = [{"sql": s["sql"], "dialect": dialect, "user": s.get("user") or "?", "ref": s.get("ref")} for s in job.get("statements", [])]
    trace = history.trace(statements, sc["tables"], dialect)
    findings = checks.grain_findings(sc["tables"])
    seen = {(f["check"], f["message"]) for f in findings}
    for st in statements[:MAX_LINTED]:
        for f in checks.lint(st["sql"], dialect, sc["tables"], sc):
            if (f["check"], f["message"]) not in seen:
                seen.add((f["check"], f["message"]))
                findings.append(f)
    definitions = draft.draft(sc, trace, min_uses=int(job.get("min_uses", 2)), min_people=int(job.get("min_people", 2)), suggest_basics=True)
    qs = questions.build_questions(sc, findings, definitions, limit=int(job.get("question_limit", 10)))
    return {"scan": sc, "definitions": definitions, "questions": qs, "findings": findings,
            "history": {"statements": trace["parsed"], "unparsed": trace["failed"], "joins": len(trace["joins"]), "named_totals": len([m for m in trace["measures"] if m["name"]])}}


def main() -> None:
    job = json.loads(sys.stdin.readline())
    try:
        if job["job"] == "analyse":
            result = analyse(job)
        elif job["job"] == "lint":
            result = {"findings": checks.lint(job["sql"], job.get("dialect", "postgres"), job["scan"]["tables"], job["scan"])}
        elif job["job"] == "resolve":
            result = checks.resolve_expression(job["expression"], job.get("dialect", "postgres"), job["scan"]["tables"])
        else:
            raise ValueError(f"unknown job {job['job']}")
        send({"result": result})
    except Exception as e:  # the control service shows a fixed message; this text goes to its log
        send({"error": f"{type(e).__name__}: {e}"[:2000]})


if __name__ == "__main__":
    main()
