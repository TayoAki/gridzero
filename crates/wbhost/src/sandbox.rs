//! One Python process per workbook (BUILD-SPEC §7), started on the first Run.
//!
//! Isolation is bubblewrap: no network, no view of other workbooks or of this
//! process's environment. Hosts that forbid namespaces (Railway) get Landlock and
//! seccomp instead, applied by the runner itself (`lockdown.py`), which exits rather
//! than run unconfined. Elsewhere Python is refused, unless
//! SANDBOX_ALLOW_UNISOLATED=1 says otherwise (developer machines and nothing else).
//! SANDBOX_MODE=landlock skips the bubblewrap attempt.
//!
//! Env: SANDBOX_DIR (/opt/sandbox: runner.py, gridzero.py, venv/),
//! SANDBOX_PYTHON (the venv's python), SANDBOX_MEM_MB (1024).

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::rc::Rc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use engine::CustomValue;
use serde_json::{json, Value};

/// How long a Run may take (§5.4: 120 s for `run_python`).
pub const RUN_TIMEOUT: Duration = Duration::from_secs(120);
/// How long one custom-function call may take.
const CALL_TIMEOUT: Duration = Duration::from_secs(5);
const START_TIMEOUT: Duration = Duration::from_secs(20);
/// Remembered function results; a recalculation otherwise calls Python for every cell.
const MAX_CACHED_CALLS: usize = 200_000;

pub struct RunResult {
    pub output: String,
    pub error: Option<String>,
    pub functions: Vec<String>,
}

pub struct Sandbox {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    functions: Vec<String>,
    cache: HashMap<String, CustomValue>,
    /// A call timed out and the process was killed; functions fail until the next Run.
    dead: bool,
}

/// Shared between the actor and the formula engine's hook.
pub type Shared = Rc<RefCell<Option<Sandbox>>>;

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn sandbox_dir() -> PathBuf {
    std::env::var_os("SANDBOX_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/opt/sandbox"))
}

fn python_path(dir: &Path) -> PathBuf {
    std::env::var_os("SANDBOX_PYTHON")
        .map(PathBuf::from)
        .unwrap_or_else(|| dir.join("venv/bin/python"))
}

fn bubblewrap(dir: &Path, work: &Path, python: &Path, mem: &str) -> Command {
    let mut c = Command::new("bwrap");
    for fixed in [
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
    ] {
        c.arg(fixed);
    }
    for path in [
        "/usr", "/bin", "/lib", "/lib64", "/lib32", "/libx32", "/etc/ssl",
    ] {
        c.args(["--ro-bind-try", path, path]);
    }
    c.arg("--ro-bind").args([dir, dir]);
    c.arg("--bind").arg(work).arg("/wb");
    c.args(["--proc", "/proc", "--dev", "/dev"]);
    c.args(["--size", "536870912", "--tmpfs", "/tmp"]);
    c.args(["--setenv", "HOME", "/tmp"]);
    c.args(["--setenv", "SANDBOX_MEM_MB", mem]);
    c.args(["--setenv", "SANDBOX_WORK_DIR", "/wb"]);
    c.arg("--setenv").arg("PYTHONPATH").arg(dir);
    c.args(["--setenv", "PYTHONDONTWRITEBYTECODE", "1"]);
    c.arg("--").arg(python).arg(dir.join("runner.py"));
    c
}

fn unisolated(dir: &Path, work: &Path, python: &Path, mem: &str) -> Command {
    let mut c = Command::new(python);
    c.arg(dir.join("runner.py"));
    c.env_clear();
    // Windows needs these two for Python to start at all.
    for keep in ["SYSTEMROOT", "PATH"] {
        if let Some(v) = std::env::var_os(keep) {
            c.env(keep, v);
        }
    }
    c.env("PYTHONPATH", dir);
    c.env("SANDBOX_WORK_DIR", work);
    c.env("SANDBOX_MEM_MB", mem);
    c.env("PYTHONDONTWRITEBYTECODE", "1");
    c.env("PYTHONIOENCODING", "utf-8");
    c
}

/// Uid Python runs as when the host is root (`nobody`).
#[cfg(unix)]
const SANDBOX_UID: u32 = 65534;

/// Landlock and seccomp, as an unprivileged user with an empty environment.
#[cfg(unix)]
fn lockdown(dir: &Path, work: &Path, python: &Path, mem: &str) -> Result<Command, String> {
    use std::os::unix::fs::{chown, PermissionsExt};
    use std::os::unix::process::CommandExt;

    let tmp = work.join("tmp");
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let mut c = Command::new(python);
    c.arg(dir.join("runner.py"));
    c.env_clear();
    c.env("PYTHONPATH", dir);
    c.env("SANDBOX_WORK_DIR", work);
    c.env("SANDBOX_MEM_MB", mem);
    c.env("SANDBOX_LOCKDOWN", "1");
    c.env("HOME", &tmp);
    c.env("TMPDIR", &tmp);
    c.env("PYTHONDONTWRITEBYTECODE", "1");
    c.env("PYTHONIOENCODING", "utf-8");
    // SAFETY: geteuid has no preconditions.
    if unsafe { libc::geteuid() } == 0 {
        for path in [work, tmp.as_path()] {
            chown(path, Some(SANDBOX_UID), Some(SANDBOX_UID)).map_err(|e| e.to_string())?;
        }
        // It has to walk down to its folder; Landlock stops it looking around on the way.
        for parent in work.ancestors().skip(1) {
            let meta = std::fs::metadata(parent).map_err(|e| e.to_string())?;
            let mode = meta.permissions().mode();
            if mode & 0o001 == 0 {
                let perms = std::fs::Permissions::from_mode(mode | 0o001);
                std::fs::set_permissions(parent, perms).map_err(|e| e.to_string())?;
            }
        }
        c.uid(SANDBOX_UID).gid(SANDBOX_UID);
    }
    Ok(c)
}

#[cfg(not(unix))]
fn lockdown(_: &Path, _: &Path, _: &Path, _: &str) -> Result<Command, String> {
    Err("not available on this platform".into())
}

fn bubblewrap_works() -> bool {
    Command::new("bwrap")
        .args(["--unshare-all", "--ro-bind", "/", "/", "--", "true"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

impl Sandbox {
    /// Start Python for a workbook. `work` is the only host folder it can see.
    pub fn start(work: &Path) -> Result<Sandbox, String> {
        let dir = sandbox_dir();
        let python = python_path(&dir);
        let mem = std::env::var("SANDBOX_MEM_MB").unwrap_or_else(|_| "1024".into());
        let allow_unisolated = std::env::var("SANDBOX_ALLOW_UNISOLATED").is_ok_and(|v| v == "1");
        std::fs::create_dir_all(work).map_err(|e| e.to_string())?;
        let force_landlock = std::env::var("SANDBOX_MODE").is_ok_and(|v| v == "landlock");
        let mut command = if cfg!(target_os = "linux") && !force_landlock && bubblewrap_works() {
            bubblewrap(&dir, work, &python, &mem)
        } else if cfg!(target_os = "linux") {
            lockdown(&dir, work, &python, &mem)?
        } else if allow_unisolated {
            unisolated(&dir, work, &python, &mem)
        } else {
            return Err(
                "Python is not available on this server: its sandbox could not start".into(),
            );
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Python could not start: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let mut sandbox = Sandbox {
            child,
            stdin,
            lines,
            functions: Vec::new(),
            cache: HashMap::new(),
            dead: false,
        };
        sandbox
            .next_message(START_TIMEOUT)
            .map_err(|_| "Python could not start in its sandbox".to_string())?;
        Ok(sandbox)
    }

    pub fn is_alive(&mut self) -> bool {
        !self.dead && matches!(self.child.try_wait(), Ok(None))
    }

    fn next_message(&mut self, timeout: Duration) -> Result<Value, RecvTimeoutError> {
        let line = self.lines.recv_timeout(timeout)?;
        serde_json::from_str(&line).map_err(|_| RecvTimeoutError::Disconnected)
    }

    fn send(&mut self, message: &Value) -> Result<(), String> {
        writeln!(self.stdin, "{message}")
            .and_then(|()| self.stdin.flush())
            .map_err(|_| "Python has stopped".to_string())
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        self.dead = true;
    }

    /// Wait for a command to finish, answering what the code asks of the workbook.
    fn finish(
        &mut self,
        timeout: Duration,
        rpc: &mut dyn FnMut(&Value) -> Result<Value, String>,
    ) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.next_message(left) {
                Ok(m) => {
                    if let Some(done) = m.get("done") {
                        return Ok(done.clone());
                    }
                    if let Some(request) = m.get("rpc") {
                        let reply = match rpc(request) {
                            Ok(result) => json!({ "result": result }),
                            Err(error) => json!({ "error": error }),
                        };
                        self.send(&reply)?;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    self.kill();
                    return Err(format!(
                        "The code took longer than {} seconds and was stopped",
                        timeout.as_secs()
                    ));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    self.dead = true;
                    return Err(
                        "Python stopped unexpectedly (it may have run out of memory)".into(),
                    );
                }
            }
        }
    }

    /// Run the module; afterwards its top-level functions can be used in formulas.
    pub fn run(
        &mut self,
        source: &str,
        rpc: &mut dyn FnMut(&Value) -> Result<Value, String>,
    ) -> Result<RunResult, String> {
        self.cache.clear();
        self.send(&json!({ "op": "run", "source": source }))?;
        let done = self.finish(RUN_TIMEOUT, rpc)?;
        self.functions = done["functions"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        Ok(RunResult {
            output: done["output"].as_str().unwrap_or_default().to_string(),
            error: done["error"].as_str().map(String::from),
            functions: self.functions.clone(),
        })
    }

    pub fn has_function(&self, name: &str) -> bool {
        self.functions.iter().any(|f| f.eq_ignore_ascii_case(name))
    }

    /// Call a custom function, remembering the answer until the next Run.
    pub fn call(&mut self, name: &str, args: &[CustomValue]) -> CustomValue {
        if self.dead {
            return CustomValue::Error("Python was stopped; press Run to restart it".into());
        }
        let wire: Vec<Value> = args.iter().map(to_json).collect();
        let request = json!({ "op": "call", "name": name, "args": wire });
        let key = request.to_string();
        if let Some(hit) = self.cache.get(&key) {
            return hit.clone();
        }
        if let Err(e) = self.send(&request) {
            return CustomValue::Error(e);
        }
        let mut no_rpc = |_: &Value| -> Result<Value, String> {
            Err(
                "Custom functions cannot read or change the workbook; pass the cells as arguments"
                    .into(),
            )
        };
        let value = match self.finish(CALL_TIMEOUT, &mut no_rpc) {
            Ok(done) => match done.get("error").and_then(Value::as_str) {
                Some(e) => CustomValue::Error(e.to_string()),
                None => from_json(done.get("value").unwrap_or(&Value::Null)),
            },
            Err(e) => CustomValue::Error(e),
        };
        if self.cache.len() >= MAX_CACHED_CALLS {
            self.cache.clear();
        }
        self.cache.insert(key, value.clone());
        value
    }
}

fn to_json(v: &CustomValue) -> Value {
    match v {
        CustomValue::Blank | CustomValue::Error(_) => Value::Null,
        CustomValue::Number(n) => json!(n),
        CustomValue::Text(s) => json!(s),
        CustomValue::Bool(b) => json!(b),
        // One row or one column arrives as a flat list.
        CustomValue::Range(rows) if rows.len() == 1 => {
            Value::Array(rows[0].iter().map(to_json).collect())
        }
        CustomValue::Range(rows) if rows.iter().all(|r| r.len() == 1) => {
            Value::Array(rows.iter().map(|r| to_json(&r[0])).collect())
        }
        CustomValue::Range(rows) => Value::Array(
            rows.iter()
                .map(|r| Value::Array(r.iter().map(to_json).collect()))
                .collect(),
        ),
    }
}

fn from_json(v: &Value) -> CustomValue {
    match v {
        Value::Number(n) => CustomValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => CustomValue::Text(s.clone()),
        Value::Bool(b) => CustomValue::Bool(*b),
        _ => CustomValue::Blank,
    }
}
