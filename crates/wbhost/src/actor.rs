//! One actor per open workbook (BUILD-SPEC §3.1). Each actor is an OS thread
//! that owns its `Workbook` exclusively; sessions talk to it over a channel.
//! IronCalc evaluation is synchronous and can take ~1 s on big sheets, so a
//! dedicated thread keeps it off the async runtime.

use std::collections::HashMap;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use engine::{Workbook, ENGINE_VERSION};
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
}

fn rehydrate(id: &str, store: &DirStore) -> Workbook {
    let loaded = match store.load(id) {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(workbook = id, error = %e, "load failed; starting empty");
            return Workbook::new_empty();
        }
    };
    let mut wb = match loaded.snapshot {
        Some(s) => {
            if s.engine != ENGINE_VERSION {
                tracing::warn!(workbook = id, snapshot_engine = s.engine, "snapshot written by a different engine version");
            }
            Workbook::from_snapshot(&s.data, s.seq).unwrap_or_else(|e| {
                tracing::error!(workbook = id, error = e, "snapshot unreadable; starting empty");
                Workbook::new_empty()
            })
        }
        None => Workbook::new_empty(),
    };
    let replayed = loaded.ops.len();
    for (seq, op) in &loaded.ops {
        if let Err(e) = wb.replay(*seq, op) {
            tracing::error!(workbook = id, seq, error = %e, "replay failed");
        }
    }
    if replayed > 0 {
        wb.evaluate();
    }
    tracing::info!(workbook = id, seq = wb.seq, replayed, "workbook loaded");
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
                sessions.insert(sid, Session { role, out });
            }
            Cmd::Leave { sid } => {
                sessions.remove(&sid);
                if sessions.is_empty() {
                    snapshot(&id, &wb, &config, &mut last_snapshot);
                }
            }
            Cmd::Msg { sid, msg } => {
                let Some(session) = sessions.get(&sid) else { continue };
                let role = session.role;
                let reply = handle(&id, &mut wb, &config, role, msg, &sessions);
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

fn handle(id: &str, wb: &mut Workbook, config: &Config, role: Role, msg: ClientMsg, sessions: &HashMap<u64, Session>) -> Option<ServerMsg> {
    let req_id = msg.req_id;
    let error = |code: &str, message: String| Some(ServerMsg::Error { req_id, code: code.into(), message });
    match msg.action {
        Action::Hello => Some(ServerMsg::Welcome { seq: wb.seq, sheets: wb.sheets(), role: role.as_str().into() }),
        Action::Ping => Some(ServerMsg::Pong { req_id }),
        Action::GetTiles { sheet, tiles } => Some(ServerMsg::Tiles {
            req_id,
            seq: wb.seq,
            sheet,
            tiles: tiles.iter().map(|[tr, tc]| wb.tile(sheet, *tr, *tc)).collect(),
        }),
        Action::GetCell { sheet, row, col } => match wb.cell_raw(sheet, row, col) {
            Ok(raw) => Some(ServerMsg::Cell { req_id, sheet, row, col, raw }),
            Err(e) => error("bad_request", e.to_string()),
        },
        action @ Action::UpdateCell { .. } => {
            if role == Role::Viewer {
                return error("forbidden", "viewers cannot edit".into());
            }
            let seq = match wb.apply(&action) {
                Ok(seq) => seq,
                Err(e) => return error("bad_request", e.to_string()),
            };
            // Durable before acknowledged: the op is fsynced before anyone hears about it.
            if let Err(e) = config.store.append(id, seq, &action) {
                tracing::error!(workbook = id, seq, error = %e, "op-log append failed");
                return error("storage", "edit applied but could not be saved".into());
            }
            let changed = ServerMsg::Changed { seq }.encode();
            for s in sessions.values() {
                let _ = s.out.send(changed.clone());
            }
            Some(ServerMsg::Ack { req_id, seq })
        }
    }
}

fn snapshot(id: &str, wb: &Workbook, config: &Config, last: &mut u64) {
    if wb.seq == *last {
        return;
    }
    match config.store.write_snapshot(id, ENGINE_VERSION, wb.seq, wb.to_snapshot()) {
        Ok(()) => {
            *last = wb.seq;
            tracing::info!(workbook = id, seq = wb.seq, "snapshot written");
        }
        Err(e) => tracing::error!(workbook = id, error = %e, "snapshot failed"),
    }
}
