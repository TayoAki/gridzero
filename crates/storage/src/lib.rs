//! Workbook persistence: snapshot + op-log (BUILD-SPEC §3.1, §4.3).
//!
//! Local-directory backend for M1 slice 1:
//!   {root}/{workbook}/snapshot.msgpack   MessagePack envelope around engine bytes
//!   {root}/{workbook}/oplog.jsonl        one {"seq":n,"op":{...}} line per mutation
//! Every append is fsynced, so an acknowledged edit survives a process crash.
//! S3 replaces this backend in M1 slice 5.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use protocol::Action;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct SnapshotEnvelope {
    v: u32,
    engine: String,
    seq: u64,
    #[serde(with = "serde_bytes")]
    data: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
struct OpLine {
    seq: u64,
    op: Action,
}

pub struct Snapshot {
    pub engine: String,
    pub seq: u64,
    pub data: Vec<u8>,
}

/// Everything needed to rehydrate a workbook: the latest snapshot (if any) and the ops after it.
pub struct Loaded {
    pub snapshot: Option<Snapshot>,
    pub ops: Vec<(u64, Action)>,
}

pub struct DirStore {
    root: PathBuf,
}

impl DirStore {
    pub fn new(root: impl Into<PathBuf>) -> std::io::Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(DirStore { root })
    }

    fn dir(&self, workbook: &str) -> std::io::Result<PathBuf> {
        // Ids come from routing tokens, but never let one escape the root.
        if workbook.is_empty() || !workbook.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid workbook id"));
        }
        let dir = self.root.join(workbook);
        fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    pub fn load(&self, workbook: &str) -> std::io::Result<Loaded> {
        let dir = self.dir(workbook)?;
        let snapshot = match fs::read(dir.join("snapshot.msgpack")) {
            Ok(bytes) => {
                let env: SnapshotEnvelope = rmp_serde::from_slice(&bytes).map_err(invalid)?;
                Some(Snapshot { engine: env.engine, seq: env.seq, data: env.data })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        let after = snapshot.as_ref().map_or(0, |s| s.seq);
        let mut ops = Vec::new();
        if let Ok(file) = File::open(dir.join("oplog.jsonl")) {
            for line in BufReader::new(file).lines() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                // A torn final line from a crash mid-write is dropped; it was never acknowledged.
                let Ok(op) = serde_json::from_str::<OpLine>(&line) else { break };
                if op.seq > after {
                    ops.push((op.seq, op.op));
                }
            }
        }
        Ok(Loaded { snapshot, ops })
    }

    pub fn append(&self, workbook: &str, seq: u64, op: &Action) -> std::io::Result<()> {
        let path = self.dir(workbook)?.join("oplog.jsonl");
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        let mut line = serde_json::to_vec(&OpLine { seq, op: op.clone() }).map_err(invalid)?;
        line.push(b'\n');
        file.write_all(&line)?;
        file.sync_data()
    }

    /// Write a snapshot atomically, then drop op-log entries it already covers.
    pub fn write_snapshot(&self, workbook: &str, engine: &str, seq: u64, data: Vec<u8>) -> std::io::Result<()> {
        let dir = self.dir(workbook)?;
        let bytes = rmp_serde::to_vec_named(&SnapshotEnvelope { v: 1, engine: engine.into(), seq, data }).map_err(invalid)?;
        write_atomic(&dir.join("snapshot.msgpack"), &bytes)?;

        let log = dir.join("oplog.jsonl");
        let remaining: Vec<String> = match File::open(&log) {
            Ok(file) => BufReader::new(file)
                .lines()
                .map_while(Result::ok)
                .filter(|l| serde_json::from_str::<OpLine>(l).is_ok_and(|op| op.seq > seq))
                .collect(),
            Err(_) => Vec::new(),
        };
        let mut body = remaining.join("\n");
        if !body.is_empty() {
            body.push('\n');
        }
        write_atomic(&log, body.as_bytes())
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    let mut file = File::create(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(tmp, path)
}

fn invalid(e: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(raw: &str) -> Action {
        Action::UpdateCell { sheet: 0, row: 0, col: 0, raw: raw.into() }
    }

    #[test]
    fn ops_survive_reopen_and_snapshot_truncates_log() {
        let tmp = tempfile::tempdir().unwrap();
        let store = DirStore::new(tmp.path()).unwrap();
        for (seq, raw) in [(1, "a"), (2, "b"), (3, "c")] {
            store.append("WB1", seq, &op(raw)).unwrap();
        }
        let loaded = DirStore::new(tmp.path()).unwrap().load("WB1").unwrap();
        assert!(loaded.snapshot.is_none());
        assert_eq!(loaded.ops.len(), 3);

        store.write_snapshot("WB1", "test@1", 2, vec![9, 9]).unwrap();
        let loaded = store.load("WB1").unwrap();
        let snap = loaded.snapshot.unwrap();
        assert_eq!((snap.seq, snap.data, snap.engine.as_str()), (2, vec![9, 9], "test@1"));
        assert_eq!(loaded.ops, vec![(3, op("c"))]);
    }

    #[test]
    fn torn_final_line_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let store = DirStore::new(tmp.path()).unwrap();
        store.append("WB2", 1, &op("x")).unwrap();
        let mut f = OpenOptions::new().append(true).open(tmp.path().join("WB2/oplog.jsonl")).unwrap();
        f.write_all(br#"{"seq":2,"op":{"type":"Upda"#).unwrap();
        assert_eq!(store.load("WB2").unwrap().ops, vec![(1, op("x"))]);
    }

    #[test]
    fn rejects_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let store = DirStore::new(tmp.path()).unwrap();
        assert!(store.load("../etc").is_err());
    }
}
