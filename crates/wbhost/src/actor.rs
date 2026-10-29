//! One actor per open workbook (BUILD-SPEC §3.1). Each actor is an OS thread
//! that owns its `Workbook` exclusively; sessions talk to it over a channel.
//! IronCalc evaluation is synchronous and can take ~1 s on big sheets, so a
//! dedicated thread keeps it off the async runtime.

use std::collections::HashMap;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use engine::{Outcome, SessionClipboard, Workbook, ENGINE_VERSION};
use protocol::{Action, ClientMsg, ServerMsg};
use storage::DirStore;
use tokio::sync::mpsc::UnboundedSender;

pub type Outbox = UnboundedSender<Vec<u8>>;

pub enum Cmd {
    Join { sid: u64, role: Role, out: Outbox },
    Leave { sid: u64 },
    Msg { sid: u64, msg: ClientMsg },
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

    pub fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

struct Session {
    role: Role,
    out: Outbox,
    /// Internal clipboard for formula- and style-preserving paste within this session.
    clipboard: Option<SessionClipboard>,
}

fn rehydrate(id: &str, store: &DirStore) -> Workbook {
    let started = Instant::now();
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

    loop {
        let cmd = match rx.recv_timeout(config.idle_evict) {
            Ok(cmd) => cmd,
            Err(RecvTimeoutError::Timeout) if sessions.is_empty() => {
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
                        snapshot(&id, &wb, &config, &mut last_snapshot);
                        tracing::info!(workbook = id, seq = wb.seq, "evicted after idle timeout");
                        return;
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        };

        match cmd {
            Cmd::Join { sid, role, out } => {
                sessions.insert(
                    sid,
                    Session {
                        role,
                        out,
                        clipboard: None,
                    },
                );
            }
            Cmd::Leave { sid } => {
                sessions.remove(&sid);
                if sessions.is_empty() {
                    snapshot(&id, &wb, &config, &mut last_snapshot);
                }
            }
            Cmd::Msg { sid, msg } => {
                let reply = handle(
                    &id,
                    &mut wb,
                    &config,
                    sid,
                    msg,
                    &mut sessions,
                    &mut last_snapshot,
                );
                if let (Some(reply), Some(session)) = (reply, sessions.get(&sid)) {
                    let _ = session.out.send(reply.encode());
                }
                if wb.seq >= last_snapshot + config.snapshot_every {
                    snapshot(&id, &wb, &config, &mut last_snapshot);
                }
            }
        }
    }
}

fn handle(
    id: &str,
    wb: &mut Workbook,
    config: &Config,
    sid: u64,
    msg: ClientMsg,
    sessions: &mut HashMap<u64, Session>,
    last_snapshot: &mut u64,
) -> Option<ServerMsg> {
    let req_id = msg.req_id;
    let session = sessions.get_mut(&sid)?;
    let role = session.role;
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

fn snapshot(id: &str, wb: &Workbook, config: &Config, last: &mut u64) {
    if wb.seq == *last {
        return;
    }
    let snap = wb.to_snapshot();
    match config
        .store
        .write_snapshot(id, ENGINE_VERSION, wb.seq, snap.data, Some(snap.tables))
    {
        Ok(()) => {
            *last = wb.seq;
            tracing::info!(workbook = id, seq = wb.seq, "snapshot written");
        }
        Err(e) => tracing::error!(workbook = id, error = %e, "snapshot failed"),
    }
}
