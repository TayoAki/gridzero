"""Runs one workbook's Python module and its custom functions.

The workbook host starts this inside the sandbox and talks JSON lines over
stdin/stdout. Host to runner: {"op":"run","source":...} and
{"op":"call","name":...,"args":[...]}. Runner to host: one {"done":...} per
command, and {"rpc":...} requests (see gridzero.py) answered on stdin.

The real boundary is the sandbox around this process (see README.md). The audit
hook below is only a second layer, and the whole boundary on a developer machine.
"""

import ast
import contextlib
import datetime as dt
import inspect
import io
import json
import os
import sys
import traceback

MAX_OUTPUT = 1 << 20


def _deny(event, args):
    if event in ("socket.connect", "socket.bind", "socket.getaddrinfo", "socket.sendto"):
        raise PermissionError("Network access is not available in the Python sandbox")
    if event in ("subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.fork"):
        raise PermissionError("Starting programs is not available in the Python sandbox")


def _limit_resources():
    try:
        import resource
    except ImportError:
        return
    memory = int(os.environ.get("SANDBOX_MEM_MB", "1024")) << 20
    for name, value in (("RLIMIT_AS", memory), ("RLIMIT_FSIZE", 512 << 20), ("RLIMIT_CORE", 0)):
        with contextlib.suppress(ValueError, OSError):
            resource.setrlimit(getattr(resource, name), (value, value))


class _Limited(io.StringIO):
    def write(self, s):
        if self.tell() < MAX_OUTPUT:
            return super().write(s)
        return len(s)


_to_host = None
_from_host = None


def _send(message):
    _to_host.write(json.dumps(message, default=str) + "\n")
    _to_host.flush()


def rpc(request):
    """Ask the workbook host for something; raises on failure."""
    _send({"rpc": request})
    reply = json.loads(_from_host.readline())
    if "error" in reply:
        raise RuntimeError(reply["error"])
    return reply.get("result")


_functions = {}


def _run(source):
    _functions.clear()
    namespace = {"__name__": "__main__"}
    output = _Limited()
    error = None
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        try:
            tree = ast.parse(source, "<code>")
            exec(compile(tree, "<code>", "exec"), namespace)
            for node in tree.body:
                if isinstance(node, ast.FunctionDef) and not node.name.startswith("_"):
                    value = namespace.get(node.name)
                    if inspect.isfunction(value):
                        _functions[node.name.lower()] = value
        except BaseException:
            error = "".join(traceback.format_exc(limit=-3))
    return {"output": output.getvalue(), "error": error, "functions": sorted(_functions)}


def _scalar(value):
    """A Python result as a cell value."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dt.datetime):
        return (value - dt.datetime(1899, 12, 30)).total_seconds() / 86400
    if isinstance(value, dt.date):
        return (value - dt.date(1899, 12, 30)).days
    if hasattr(value, "item"):
        return _scalar(value.item())
    raise TypeError(f"A function must return one value, not {type(value).__name__}")


def _call(name, args):
    fn = _functions.get(name.lower())
    if fn is None:
        return {"missing": True}
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return {"value": _scalar(fn(*args))}
    except BaseException as e:
        return {"error": f"{type(e).__name__}: {e}"}


def main():
    global _to_host, _from_host
    # Printing from user code must never reach the protocol stream.
    _to_host = os.fdopen(os.dup(1), "w", encoding="utf-8")
    _from_host = os.fdopen(os.dup(0), "r", encoding="utf-8")
    os.dup2(os.open(os.devnull, os.O_RDWR), 0)
    os.dup2(os.open(os.devnull, os.O_RDWR), 1)
    _limit_resources()
    sys.modules["_gridzero_runner"] = sys.modules[__name__]
    sys.addaudithook(_deny)
    _send({"ready": True})
    for line in _from_host:
        command = json.loads(line)
        if command["op"] == "run":
            _send({"done": _run(command["source"])})
        elif command["op"] == "call":
            _send({"done": _call(command["name"], command["args"])})


if __name__ == "__main__":
    main()
