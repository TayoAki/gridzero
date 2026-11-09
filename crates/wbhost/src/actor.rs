//! One actor per open workbook (BUILD-SPEC §3.1). Each actor is an OS thread
//! that owns its `Workbook` exclusively; sessions talk to it over a channel.
//! IronCalc evaluation is synchronous and can take ~1 s on big sheets, so a
//! dedicated thread keeps it off the async runtime.

use std::collections::HashMap;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::sandbox::{self, Sandbox};
use engine::{Outcome, SessionClipboard, Workbook, ENGINE_VERSION};
use protocol::{Action, ClientMsg, Peer, Range, Reply, ServerMsg, VersionInfo};
use storage::DirStore;
use tokio::sync::mpsc::UnboundedSender;

pub type Outbox = UnboundedSender<Vec<u8>>;

pub enum Cmd {
    Join {
        sid: u64,
        role: Role,
        user: String,
        name: String,
        out: Outbox,
    },
    Leave {
        sid: u64,
    },
    /// The shared code editor's socket.
    CodeJoin {
        sid: u64,
        role: Role,
        out: Outbox,
    },
    CodeFrame {
        sid: u64,
        frame: Vec<u8>,
    },
    CodeLeave {
        sid: u64,
    },
    Msg {
        sid: u64,
        msg: ClientMsg,
    },
    /// A read-only query from an HTTP route: the reply with the workbook's seq.
    Query {
        action: Action,
        reply: tokio::sync::oneshot::Sender<Result<(u64, Reply), String>>,
    },
    /// Apply one change from the control plane (a connected table's refresh).
    Apply {
        action: Action,
        reply: tokio::sync::oneshot::Sender<Result<Reply, String>>,
    },
    /// Close a user's sessions after their access changed; they reconnect with a new
    /// grant, or are refused one.
    Revoke {
        user: String,
    },
    /// Write everything to disk, then copy the workbook to `to`.
    Copy {
        to: String,
        reply: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    /// Delete the workbook for good and stop the actor.
    Purge {
        reply: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Role {
    Owner,
    Editor,
    Viewer,
}

impl Role {
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "owner" => Some(Role::Owner),
            "editor" => Some(Role::Editor),
            "viewer" => Some(Role::Viewer),
            _ => None,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Editor => "editor",
            Role::Viewer => "viewer",
        }
    }
}

pub struct Config {
    pub store: Arc<DirStore>,
    pub idle_evict: Duration,
    pub snapshot_every: u64,
}

/// Diffs larger than this (e.g. a big "import into cells") are persisted by writing a
/// snapshot instead of an op-log line.
const SNAPSHOT_INSTEAD_OF_APPEND: usize = 32 << 20;

/// workbook id -> actor mailbox. An actor removes itself when it evicts.
#[derive(Clone, Default)]
pub struct Registry(Arc<Mutex<HashMap<String, mpsc::Sender<Cmd>>>>);

impl Registry {
    /// Mailbox for `id`, spawning (and rehydrating) the actor if it is not running.
    pub fn get_or_spawn(&self, id: &str, config: &Arc<Config>) -> mpsc::Sender<Cmd> {
        let mut map = self.0.lock().unwrap();
        if let Some(tx) = map.get(id) {
            return tx.clone();
        }
        let (tx, rx) = mpsc::channel();
        map.insert(id.to_string(), tx.clone());
        let (id, registry, config) = (id.to_string(), self.clone(), config.clone());
        std::thread::Builder::new()
            .name(format!("wb-{id}"))
            .spawn(move || run(id, rx, registry, config))
            .expect("spawn workbook actor");
        tx
    }

    /// Mailbox for `id` if its actor is running.
    pub fn get(&self, id: &str) -> Option<mpsc::Sender<Cmd>> {
        self.0.lock().unwrap().get(id).cloned()
    }

    pub fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

struct Session {
    role: Role,
    user: String,
    name: String,
    presence: Option<(u32, Range, [u32; 2], Option<u64>)>,
    out: Outbox,
    /// Internal clipboard for formula- and style-preserving paste within this session.
    clipboard: Option<SessionClipboard>,
}

/// Colours for other people's selections, picked by session id.
const PEER_COLORS: [&str; 8] = [
    "#E8710A", "#12B5CB", "#9334E6", "#E52592", "#188038", "#F9AB00", "#4285F4", "#A50E0E",
];

fn broadcast_presence(sessions: &HashMap<u64, Session>) {
    let peers: Vec<Peer> = sessions
        .iter()
        .map(|(id, s)| {
            let (sheet, selection, view, following) = match s.presence {
                Some((sheet, range, view, following)) => (sheet, Some(range), view, following),
                None => (0, None, [0, 0], None),
            };
            Peer {
                id: *id,
                name: s.name.clone(),
                color: PEER_COLORS[*id as usize % PEER_COLORS.len()].to_string(),
                sheet,
                selection,
                view,
                following,
            }
        })
        .collect();
    for (id, s) in sessions {
        let msg = ServerMsg::Presence {
            you: *id,
            peers: peers.clone(),
        };
        let _ = s.out.send(msg.encode());
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// A read-only copy of one saved version, opened as its own actor: `{id}@{seq}`.
fn split_preview(id: &str) -> (&str, Option<u64>) {
    match id.split_once('@') {
        Some((base, seq)) => (base, seq.parse().ok()),
        None => (id, None),
    }
}

fn rehydrate_version(id: &str, seq: u64, store: &DirStore) -> Result<Workbook, String> {
    let dir = store.workbook_dir(id).map_err(|e| e.to_string())?;
    let snap = store.load_version(id, seq).map_err(|e| e.to_string())?;
    Workbook::from_snapshot(&snap.data, snap.tables.as_deref(), snap.seq, dir)
}

fn rehydrate(id: &str, store: &DirStore) -> Workbook {
    let started = Instant::now();
    if let (base, Some(seq)) = split_preview(id) {
        return rehydrate_version(base, seq, store).unwrap_or_else(|e| {
            tracing::error!(workbook = id, error = e, "version unreadable");
            Workbook::new_empty()
        });
    }
    let dir = match store.workbook_dir(id) {
        Ok(d) => d,
        Err(e) => {
            tracing::error!(workbook = id, error = %e, "no workbook directory; starting empty");
            return Workbook::new_empty();
        }
    };
    let loaded = match store.load(id) {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(workbook = id, error = %e, "load failed; starting empty");
            return Workbook::new_in(dir);
        }
    };
    let mut wb = match loaded.snapshot {
        Some(s) => {
            if s.engine != ENGINE_VERSION {
                tracing::warn!(
                    workbook = id,
                    snapshot_engine = s.engine,
                    "snapshot written by a different engine version"
                );
            }
            Workbook::from_snapshot(&s.data, s.tables.as_deref(), s.seq, dir.clone())
                .unwrap_or_else(|e| {
                    tracing::error!(
                        workbook = id,
                        error = e,
                        "snapshot unreadable; starting empty"
                    );
                    Workbook::new_in(dir.clone())
                })
        }
        None => Workbook::new_in(dir),
    };
    let replayed = loaded.ops.len();
    for op in &loaded.ops {
        if let Err(e) = wb.replay(op.seq, &op.diffs, op.tables.as_deref()) {
            tracing::error!(workbook = id, seq = op.seq, error = %e, "replay failed");
        }
    }
    if replayed > 0 {
        wb.evaluate();
    }
    tracing::info!(
        workbook = id,
        seq = wb.seq,
        replayed,
        tables = wb.tables().manifest().tables.len(),
        ms = started.elapsed().as_millis() as u64,
        "workbook loaded"
    );
    wb
}

fn run(id: String, rx: mpsc::Receiver<Cmd>, registry: Registry, config: Arc<Config>) {
    let mut wb = rehydrate(&id, &config.store);
    let mut sessions: HashMap<u64, Session> = HashMap::new();
    let mut last_snapshot = wb.seq;
    let python: sandbox::Shared = Default::default();
    wake(&id, &mut wb, &config, &python);
    let mut code = CodeChannel::load(&id, &config);

    loop {
        let cmd = match rx.recv_timeout(config.idle_evict) {
            Ok(cmd) => cmd,
            Err(RecvTimeoutError::Timeout) if sessions.is_empty() && code.sessions.is_empty() => {
                // Evict under the registry lock so no new Join can slip in unseen.
                let mut map = registry.0.lock().unwrap();
                match rx.try_recv() {
                    Ok(cmd) => {
                        drop(map);
                        cmd
                    }
                    Err(_) => {
                        map.remove(&id);
                        drop(map);
                        snapshot(&id, &mut wb, &config, &mut last_snapshot);
                        tracing::info!(workbook = id, seq = wb.seq, "evicted after idle timeout");
                        return;
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        };

        match cmd {
            Cmd::Join {
                sid,
                role,
                user,
                name,
                out,
            } => {
                sessions.insert(
                    sid,
                    Session {
                        role,
                        user,
                        name,
                        presence: None,
                        out,
                        clipboard: None,
                    },
                );
                broadcast_presence(&sessions);
            }
            Cmd::CodeJoin { sid, role, out } => code.join(sid, role, out, &id, &wb, &config),
            Cmd::CodeFrame { sid, frame } => code.frame(sid, frame, &id, &config),
            Cmd::CodeLeave { sid } => {
                code.sessions.remove(&sid);
            }
            Cmd::Leave { sid } => {
                sessions.remove(&sid);
                if sessions.is_empty() {
                    snapshot(&id, &mut wb, &config, &mut last_snapshot);
                } else {
                    broadcast_presence(&sessions);
                }
            }
            Cmd::Apply { action, reply } => {
                let mut changed = false;
                let result = apply(&id, &mut wb, &config, &action, &mut changed)
                    .and_then(|v| serde_json::from_value::<Reply>(v).map_err(|e| e.to_string()));
                if changed {
                    let notice = ServerMsg::Changed {
                        seq: wb.seq,
                        sheets: wb.sheets(),
                        can_undo: wb.can_undo(),
                        can_redo: wb.can_redo(),
                    }
                    .encode();
                    for s in sessions.values() {
                        let _ = s.out.send(notice.clone());
                    }
                }
                let _ = reply.send(result);
            }
            Cmd::Revoke { user } => {
                sessions.retain(|_, s| s.user != user);
                broadcast_presence(&sessions);
            }
            Cmd::Copy { to, reply } => {
                // Forced: ops replayed since the last snapshot exist only in the log.
                let result =
                    force_snapshot(&id, &mut wb, &config, &mut last_snapshot).and_then(|()| {
                        config
                            .store
                            .copy_workbook(&id, &to)
                            .map_err(|e| e.to_string())
                    });
                let _ = reply.send(result);
            }
            Cmd::Purge { reply } => {
                registry.0.lock().unwrap().remove(&id);
                sessions.clear();
                let _ = reply.send(config.store.purge(&id).map_err(|e| e.to_string()));
                return;
            }
            Cmd::Query { action, reply } => {
                let result = if action.is_mutation() {
                    Err("only queries can be sent here".to_string())
                } else {
                    match wb.execute(&action, &mut None) {
                        Ok(Outcome::Query(r)) | Ok(Outcome::Unchanged(r)) => Ok((wb.seq, r)),
                        Ok(_) => Err("unexpected mutation".to_string()),
                        Err(e) => Err(e.to_string()),
                    }
                };
                let _ = reply.send(result);
            }
            Cmd::Msg { sid, msg } => {
                let restored = matches!(msg.action, Action::RestoreVersion { .. });
                let reply = handle(
                    &id,
                    &mut wb,
                    &config,
                    sid,
                    msg,
                    &mut sessions,
                    &mut last_snapshot,
                    &python,
                );
                if restored && !matches!(reply, Some(ServerMsg::Error { .. }) | None) {
                    wake(&id, &mut wb, &config, &python);
                    code.reset(&id, &wb, &config);
                }
                if let (Some(reply), Some(session)) = (reply, sessions.get(&sid)) {
                    let _ = session.out.send(reply.encode());
                }
                if wb.seq >= last_snapshot + config.snapshot_every {
                    snapshot(&id, &mut wb, &config, &mut last_snapshot);
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn handle(
    id: &str,
    wb: &mut Workbook,
    config: &Config,
    sid: u64,
    msg: ClientMsg,
    sessions: &mut HashMap<u64, Session>,
    last_snapshot: &mut u64,
    python: &sandbox::Shared,
) -> Option<ServerMsg> {
    let req_id = msg.req_id;
    let mut msg = msg;
    let session = sessions.get_mut(&sid)?;
    let role = session.role;
    // The server, not the client, says who wrote a comment and when.
    match &mut msg.action {
        Action::AddComment { author, at, .. } | Action::ReplyComment { author, at, .. } => {
            *author = session.name.clone();
            *at = now_ms();
        }
        _ => {}
    }
    if matches!(msg.action, Action::Hello) {
        return Some(ServerMsg::Welcome {
            seq: wb.seq,
            sheets: wb.sheets(),
            role: role.as_str().into(),
            can_undo: wb.can_undo(),
            can_redo: wb.can_redo(),
        });
    }
    if msg.action.needs_edit() && role == Role::Viewer {
        return Some(ServerMsg::Error {
            req_id,
            code: "forbidden".into(),
            message: "viewers cannot edit".into(),
        });
    }
    if let Action::RunCode { source } = &msg.action {
        let source = source.clone();
        return Some(run_code(
            id,
            wb,
            config,
            sid,
            req_id,
            source,
            sessions,
            last_snapshot,
            python,
        ));
    }
    if let Action::Presence {
        sheet,
        selection,
        view,
        following,
    } = msg.action
    {
        session.presence = Some((sheet, selection, view, following));
        broadcast_presence(sessions);
        return Some(ServerMsg::Reply {
            req_id,
            seq: wb.seq,
            body: Reply::Ok,
        });
    }
    if matches!(
        msg.action,
        Action::ListVersions
            | Action::CreateVersion { .. }
            | Action::NameVersion { .. }
            | Action::RestoreVersion { .. }
    ) {
        let by = session.name.clone();
        let body = versions(id, wb, config, &msg.action, by, last_snapshot);
        return Some(match body {
            Ok(body) => {
                if matches!(msg.action, Action::RestoreVersion { .. }) {
                    let changed = ServerMsg::Changed {
                        seq: wb.seq,
                        sheets: wb.sheets(),
                        can_undo: wb.can_undo(),
                        can_redo: wb.can_redo(),
                    }
                    .encode();
                    for s in sessions.values() {
                        let _ = s.out.send(changed.clone());
                    }
                }
                ServerMsg::Reply {
                    req_id,
                    seq: wb.seq,
                    body,
                }
            }
            Err(message) => ServerMsg::Error {
                req_id,
                code: "bad_request".into(),
                message,
            },
        });
    }
    let started = Instant::now();
    let outcome = match wb.execute(&msg.action, &mut session.clipboard) {
        Ok(o) => o,
        Err(e) => {
            return Some(ServerMsg::Error {
                req_id,
                code: "bad_request".into(),
                message: e.to_string(),
            })
        }
    };
    match outcome {
        Outcome::Query(body) | Outcome::Unchanged(body) => Some(ServerMsg::Reply {
            req_id,
            seq: wb.seq,
            body,
        }),
        Outcome::Mutated {
            reply,
            seq,
            diffs,
            tables,
        } => {
            // Durable before acknowledged: the diffs are fsynced before anyone hears about them.
            let saved = if diffs.len() > SNAPSHOT_INSTEAD_OF_APPEND {
                let snap = wb.to_snapshot();
                config
                    .store
                    .write_snapshot(id, ENGINE_VERSION, seq, snap.data, Some(snap.tables))
                    .map(|()| *last_snapshot = seq)
            } else {
                config.store.append(id, seq, &diffs, tables.as_deref())
            };
            if let Err(e) = saved {
                tracing::error!(workbook = id, seq, error = %e, "op-log append failed");
                return Some(ServerMsg::Error {
                    req_id,
                    code: "storage".into(),
                    message: "edit applied but could not be saved".into(),
                });
            }
            tracing::debug!(
                workbook = id,
                seq,
                ms = started.elapsed().as_secs_f64() * 1e3,
                "mutation applied"
            );
            let changed = ServerMsg::Changed {
                seq,
                sheets: wb.sheets(),
                can_undo: wb.can_undo(),
                can_redo: wb.can_redo(),
            }
            .encode();
            for s in sessions.values() {
                let _ = s.out.send(changed.clone());
            }
            Some(ServerMsg::Reply {
                req_id,
                seq,
                body: reply,
            })
        }
    }
}

/// Most source text a Run accepts.
const MAX_SOURCE: usize = 1 << 20;

/// The folder Python can see, under the workbook's own directory.
fn work_dir(id: &str, config: &Config) -> Result<std::path::PathBuf, String> {
    let (base, _) = split_preview(id);
    let dir = config.store.workbook_dir(base).map_err(|e| e.to_string())?;
    Ok(dir.join("sandbox"))
}

/// Make the sandbox's functions callable from formulas.
fn install_hook(wb: &mut Workbook, python: &sandbox::Shared) {
    let shared = python.clone();
    wb.set_custom_functions(Some(std::rc::Rc::new(move |name, args| {
        // While a Run is in progress the sandbox is busy: functions read as unknown
        // until it finishes, and the recalculation after it fills them in.
        let mut slot = shared.try_borrow_mut().ok()?;
        let sandbox = slot.as_mut()?;
        if name.is_empty() {
            let wanted = args.first().map_or(String::new(), |a| match a {
                engine::CustomValue::Text(t) => t.clone(),
                _ => String::new(),
            });
            return sandbox
                .has_function(&wanted)
                .then_some(engine::CustomValue::Blank);
        }
        Some(sandbox.call(name, args))
    })));
}

/// Start (or restart) Python, returning an error people can read.
fn ensure_python(id: &str, config: &Config, python: &sandbox::Shared) -> Result<(), String> {
    let mut slot = python.borrow_mut();
    if !slot.as_mut().is_some_and(Sandbox::is_alive) {
        *slot = None;
        *slot = Some(Sandbox::start(&work_dir(id, config)?)?);
    }
    Ok(())
}

/// Answer what the module asks of the workbook during a Run.
fn answer_rpc(
    id: &str,
    wb: &mut Workbook,
    config: &Config,
    request: &serde_json::Value,
    can_edit: bool,
    changed: &mut bool,
) -> Result<serde_json::Value, String> {
    use serde_json::json;
    let forbid = || "This code cannot change the workbook here; use Run as an editor".to_string();
    match request["op"].as_str().unwrap_or_default() {
        "sheets" => Ok(json!(wb
            .sheets()
            .iter()
            .map(|s| json!({ "name": s.name }))
            .collect::<Vec<_>>())),
        "values" => {
            let range: Range =
                serde_json::from_value(request["range"].clone()).map_err(|e| e.to_string())?;
            Ok(json!(wb.range_values(&range)))
        }
        "table" => {
            let table = request["table"].as_str().ok_or("table is required")?;
            wb.export_table(table, &work_dir(id, config)?)
                .map(|n| json!(n))
                .map_err(|e| e.to_string())
        }
        "action" => {
            if !can_edit {
                return Err(forbid());
            }
            let action: Action =
                serde_json::from_value(request["action"].clone()).map_err(|e| e.to_string())?;
            if !action.is_mutation() {
                return Err("only changes to the workbook can be sent".into());
            }
            apply(id, wb, config, &action, changed)
        }
        "import" => {
            if !can_edit {
                return Err(forbid());
            }
            let file = request["file"].as_str().ok_or("file is required")?;
            if file.contains(['/', '\\']) || !file.ends_with(".parquet") {
                return Err("bad file name".into());
            }
            let source = work_dir(id, config)?.join(file);
            // The folder is writable from inside: never follow a link planted there.
            let meta = std::fs::symlink_metadata(&source).map_err(|e| e.to_string())?;
            if !meta.file_type().is_file() {
                return Err("bad file".into());
            }
            let import_id = format!("py{}", now_ms());
            let staging = wb.dir().join("staging");
            std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
            std::fs::rename(&source, staging.join(format!("{import_id}.data.parquet")))
                .map_err(|e| e.to_string())?;
            let action = Action::FinalizeImport {
                import_id,
                options: serde_json::from_value(json!({})).map_err(|e| e.to_string())?,
                dest: protocol::ImportDest::Cell {
                    sheet: request["sheet"].as_u64().unwrap_or(0) as u32,
                    row: request["row"].as_u64().unwrap_or(0) as u32,
                    col: request["col"].as_u64().unwrap_or(0) as u32,
                },
                mode: if request["as_table"].as_bool().unwrap_or(true) {
                    protocol::ImportMode::Table
                } else {
                    protocol::ImportMode::Cells
                },
                name: request["name"].as_str().unwrap_or("data").to_string(),
            };
            apply(id, wb, config, &action, changed)
        }
        _ => Err("unknown request".into()),
    }
}

/// Apply and persist one change made from Python.
fn apply(
    id: &str,
    wb: &mut Workbook,
    config: &Config,
    action: &Action,
    changed: &mut bool,
) -> Result<serde_json::Value, String> {
    match wb.execute(action, &mut None).map_err(|e| e.to_string())? {
        Outcome::Mutated {
            reply,
            seq,
            diffs,
            tables,
        } => {
            config
                .store
                .append(id, seq, &diffs, tables.as_deref())
                .map_err(|e| e.to_string())?;
            *changed = true;
            serde_json::to_value(reply).map_err(|e| e.to_string())
        }
        Outcome::Query(r) | Outcome::Unchanged(r) => {
            serde_json::to_value(r).map_err(|e| e.to_string())
        }
    }
}

/// Re-run the saved module after a load (BUILD-SPEC §7, "execute on wake").
fn wake(id: &str, wb: &mut Workbook, config: &Config, python: &sandbox::Shared) {
    let code = wb.tables().manifest().code.clone();
    install_hook(wb, python);
    if !code.execute_on_wake || !code.source.contains("def ") {
        return;
    }
    if let Err(e) = ensure_python(id, config, python) {
        tracing::warn!(workbook = id, error = e, "python not started on wake");
        return;
    }
    let result = {
        let mut slot = python.borrow_mut();
        let Some(sandbox) = slot.as_mut() else { return };
        let mut changed = false;
        let wb_ref = &mut *wb;
        sandbox.run(&code.source, &mut |request| {
            answer_rpc(id, wb_ref, config, request, false, &mut changed)
        })
    };
    if let Err(e) = result {
        tracing::warn!(workbook = id, error = e, "execute on wake failed");
    }
    wb.recalculate();
}

#[allow(clippy::too_many_arguments)]
fn run_code(
    id: &str,
    wb: &mut Workbook,
    config: &Config,
    sid: u64,
    req_id: u64,
    source: String,
    sessions: &mut HashMap<u64, Session>,
    last_snapshot: &mut u64,
    python: &sandbox::Shared,
) -> ServerMsg {
    let failed = |message: String| ServerMsg::Error {
        req_id,
        code: "python".into(),
        message,
    };
    if source.len() > MAX_SOURCE {
        return failed("The code is too long".into());
    }
    if split_preview(id).1.is_some() {
        return failed("A saved version is read-only".into());
    }
    if let Err(e) = ensure_python(id, config, python) {
        return failed(e);
    }
    install_hook(wb, python);
    let mut changed = false;
    let result = {
        let mut slot = python.borrow_mut();
        let Some(sandbox) = slot.as_mut() else {
            return failed("Python has stopped".into());
        };
        let wb_ref = &mut *wb;
        sandbox.run(&source, &mut |request| {
            answer_rpc(id, wb_ref, config, request, true, &mut changed)
        })
    };
    let result = match result {
        Ok(r) => r,
        Err(e) => return failed(e),
    };
    let save = ClientMsg {
        req_id,
        action: Action::SaveCode { source },
    };
    if let Some(ServerMsg::Error { message, .. }) =
        handle(id, wb, config, sid, save, sessions, last_snapshot, python)
    {
        return failed(message);
    }
    wb.recalculate();
    let _ = changed;
    let notice = ServerMsg::Changed {
        seq: wb.seq,
        sheets: wb.sheets(),
        can_undo: wb.can_undo(),
        can_redo: wb.can_redo(),
    }
    .encode();
    for s in sessions.values() {
        let _ = s.out.send(notice.clone());
    }
    ServerMsg::Reply {
        req_id,
        seq: wb.seq,
        body: Reply::CodeRun {
            output: result.output,
            error: result.error,
            functions: result.functions,
        },
    }
}

/// Frames on the code socket; the first byte says what follows.
mod code_frame {
    /// Yjs update (both ways).
    pub const UPDATE: u8 = 0;
    /// Yjs awareness (both ways, not stored).
    pub const AWARENESS: u8 = 1;
    /// Client to server: the whole document, replacing the log.
    pub const SNAPSHOT: u8 = 2;
    /// Server to client: start the document with this text.
    pub const SEED: u8 = 3;
    /// Server to client: send a SNAPSHOT.
    pub const COMPACT: u8 = 4;
    /// Server to client: throw the document away; a SEED or updates follow.
    pub const RESET: u8 = 5;
}

/// Past this many updates a newly joined editor is asked to compact the log.
const COMPACT_AFTER: usize = 2_000;

/// A relay for the Yjs editor: updates are idempotent, so storing and replaying them
/// is all a late joiner needs, without the server understanding them.
struct CodeChannel {
    sessions: HashMap<u64, (Role, Outbox)>,
    log: Vec<Vec<u8>>,
    seeded: bool,
    /// Log length when a compaction was requested.
    compacting: Option<usize>,
}

impl CodeChannel {
    fn load(id: &str, config: &Config) -> Self {
        let log = if split_preview(id).1.is_some() {
            Vec::new()
        } else {
            config.store.load_code_log(id).unwrap_or_default()
        };
        CodeChannel {
            sessions: HashMap::new(),
            log,
            seeded: false,
            compacting: None,
        }
    }

    fn tagged(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(body.len() + 1);
        out.push(tag);
        out.extend_from_slice(body);
        out
    }

    fn join(
        &mut self,
        sid: u64,
        role: Role,
        out: Outbox,
        _id: &str,
        wb: &Workbook,
        _config: &Config,
    ) {
        for update in &self.log {
            let _ = out.send(Self::tagged(code_frame::UPDATE, update));
        }
        let source = &wb.tables().manifest().code.source;
        if self.log.is_empty() && !source.is_empty() && (role == Role::Viewer || !self.seeded) {
            let _ = out.send(Self::tagged(code_frame::SEED, source.as_bytes()));
            self.seeded |= role != Role::Viewer;
        }
        if role != Role::Viewer && self.log.len() > COMPACT_AFTER && self.compacting.is_none() {
            self.compacting = Some(self.log.len());
            let _ = out.send(vec![code_frame::COMPACT]);
        }
        self.sessions.insert(sid, (role, out));
    }

    fn frame(&mut self, sid: u64, frame: Vec<u8>, id: &str, config: &Config) {
        let Some((role, _)) = self.sessions.get(&sid) else {
            return;
        };
        let role = *role;
        let Some(&tag) = frame.first() else { return };
        match tag {
            code_frame::UPDATE if role != Role::Viewer => {
                if split_preview(id).1.is_none() {
                    if let Err(e) = config.store.append_code_log(id, &frame[1..]) {
                        tracing::error!(workbook = id, error = %e, "code log append failed");
                    }
                }
                self.log.push(frame[1..].to_vec());
                self.relay(sid, &frame);
            }
            code_frame::AWARENESS => self.relay(sid, &frame),
            code_frame::SNAPSHOT if role != Role::Viewer => {
                if let Some(at) = self.compacting.take() {
                    // Updates after the request may or may not be in the snapshot; keeping
                    // them is harmless because applying an update twice changes nothing.
                    let mut log = vec![frame[1..].to_vec()];
                    log.extend_from_slice(self.log.get(at..).unwrap_or(&[]));
                    if config.store.replace_code_log(id, &log).is_ok() {
                        self.log = log;
                    }
                }
            }
            _ => {}
        }
    }

    fn relay(&self, from: u64, frame: &[u8]) {
        for (sid, (_, out)) in &self.sessions {
            if *sid != from {
                let _ = out.send(frame.to_vec());
            }
        }
    }

    /// After a restore: everyone restarts from the restored module.
    fn reset(&mut self, id: &str, wb: &Workbook, config: &Config) {
        self.log.clear();
        self.compacting = None;
        self.seeded = true;
        let _ = config.store.replace_code_log(id, &[]);
        for (_, out) in self.sessions.values() {
            let _ = out.send(vec![code_frame::RESET]);
        }
        // One editor seeds the empty document, and everyone else receives that update.
        let source = wb.tables().manifest().code.source.clone();
        let seed = Self::tagged(code_frame::SEED, source.as_bytes());
        let editor = self.sessions.values().find(|(r, _)| *r != Role::Viewer);
        match editor {
            Some((_, out)) if !source.is_empty() => {
                let _ = out.send(seed);
            }
            _ => {
                self.seeded = false;
                for (_, out) in self.sessions.values() {
                    if !source.is_empty() {
                        let _ = out.send(seed.clone());
                    }
                }
            }
        }
    }
}

/// Version history. A version is a copy of a snapshot, so restoring one is exact; a
/// restore is itself a new state at the next seq, and the state it replaces is saved
/// first, so it can be undone by restoring that.
fn versions(
    id: &str,
    wb: &mut Workbook,
    config: &Config,
    action: &Action,
    by: String,
    last: &mut u64,
) -> Result<Reply, String> {
    let list = |config: &Config| -> Result<Reply, String> {
        let list = config.store.list_versions(id).map_err(|e| e.to_string())?;
        Ok(Reply::Versions {
            list: list
                .into_iter()
                .map(|v| VersionInfo {
                    seq: v.seq,
                    at: v.at,
                    name: v.name,
                    by: v.by,
                })
                .collect(),
        })
    };
    match action {
        Action::ListVersions => list(config),
        Action::CreateVersion { name } => {
            force_snapshot(id, wb, config, last)?;
            let name = name.as_deref().map(str::trim).filter(|n| !n.is_empty());
            config
                .store
                .save_version(
                    id,
                    wb.seq,
                    now_ms(),
                    name.map(String::from),
                    name.map(|_| by.clone()),
                )
                .map_err(|e| e.to_string())?;
            list(config)
        }
        Action::NameVersion { seq, name } => {
            let name = name.trim();
            if name.is_empty() || name.len() > 255 {
                return Err("a version name must be 1 to 255 characters".into());
            }
            if !config
                .store
                .name_version(id, *seq, name)
                .map_err(|e| e.to_string())?
            {
                return Err("no such version".into());
            }
            list(config)
        }
        Action::RestoreVersion { seq } => {
            force_snapshot(id, wb, config, last)?;
            config
                .store
                .save_version(id, wb.seq, now_ms(), None, None)
                .map_err(|e| e.to_string())?;
            let dir = config.store.workbook_dir(id).map_err(|e| e.to_string())?;
            let snap = config
                .store
                .load_version(id, *seq)
                .map_err(|_| "no such version".to_string())?;
            let new_seq = wb.seq + 1;
            *wb = Workbook::from_snapshot(&snap.data, snap.tables.as_deref(), new_seq, dir)?;
            *last = new_seq - 1;
            force_snapshot(id, wb, config, last)?;
            config
                .store
                .save_version(
                    id,
                    new_seq,
                    now_ms(),
                    Some(format!("Restored from version {seq}")),
                    Some(by),
                )
                .map_err(|e| e.to_string())?;
            list(config)
        }
        _ => Err("not a version action".into()),
    }
}

/// Write a snapshot even if the seq has not moved (a new workbook has none yet).
fn force_snapshot(
    id: &str,
    wb: &mut Workbook,
    config: &Config,
    last: &mut u64,
) -> Result<(), String> {
    let snap = wb.to_snapshot();
    config
        .store
        .write_snapshot(id, ENGINE_VERSION, wb.seq, snap.data, Some(snap.tables))
        .map_err(|e| e.to_string())?;
    *last = wb.seq;
    Ok(())
}

fn snapshot(id: &str, wb: &mut Workbook, config: &Config, last: &mut u64) {
    if wb.seq == *last || split_preview(id).1.is_some() {
        return;
    }
    let snap = wb.to_snapshot();
    match config
        .store
        .write_snapshot(id, ENGINE_VERSION, wb.seq, snap.data, Some(snap.tables))
    {
        Ok(()) => {
            *last = wb.seq;
            if let Err(e) = config.store.save_version(id, wb.seq, now_ms(), None, None) {
                tracing::error!(workbook = id, error = %e, "version not recorded");
            }
            tracing::info!(workbook = id, seq = wb.seq, "snapshot written");
        }
        Err(e) => tracing::error!(workbook = id, error = %e, "snapshot failed"),
    }
}
