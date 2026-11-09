//! Workbook persistence: snapshot + op-log (BUILD-SPEC §3.1, §4.3).
//!
//! Local-directory backend for M1 slice 1:
//!   {root}/{workbook}/snapshot.msgpack   MessagePack envelope around engine bytes
//!   {root}/{workbook}/oplog.jsonl        one {"seq":n,"diffs":"<base64>","tables":"<json>"?} line
//!                                        per mutation: the engine's opaque diff bytes, plus the
//!                                        Data Table manifest after the change when tables changed
//!   {root}/{workbook}/tables/*.parquet   immutable Data Table versions (written before the op)
//!   {root}/{workbook}/staging/*          uploads waiting to be imported
//! Every append is fsynced, so an acknowledged edit survives a process crash.
//! S3 replaces this backend in M1 slice 5.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct SnapshotEnvelope {
    v: u32,
    engine: String,
    seq: u64,
    #[serde(with = "serde_bytes")]
    data: Vec<u8>,
    /// Data Table manifest (v2).
    #[serde(default)]
    tables: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct OpLine {
    seq: u64,
    diffs: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tables: Option<String>,
}

pub struct Snapshot {
    pub engine: String,
    pub seq: u64,
    pub data: Vec<u8>,
    pub tables: Option<String>,
}

#[derive(Debug, PartialEq)]
pub struct Op {
    pub seq: u64,
    pub diffs: Vec<u8>,
    pub tables: Option<String>,
}

/// Everything needed to rehydrate a workbook: the latest snapshot (if any) and the ops after it.
pub struct Loaded {
    pub snapshot: Option<Snapshot>,
    pub ops: Vec<Op>,
}

pub struct DirStore {
    root: PathBuf,
}

/// Index entry of a saved version; the snapshot is `versions/{seq}.msgpack`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VersionEntry {
    pub seq: u64,
    pub at: u64,
    pub name: Option<String>,
    pub by: Option<String>,
}

/// Unnamed versions kept per workbook; named ones are never pruned.
const KEEP_UNNAMED_VERSIONS: usize = 50;

impl DirStore {
    pub fn new(root: impl Into<PathBuf>) -> std::io::Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(DirStore { root })
    }

    /// The workbook's directory (created if needed); Data Tables and staged uploads live under it.
    pub fn workbook_dir(&self, workbook: &str) -> std::io::Result<PathBuf> {
        self.dir(workbook)
    }

    fn dir(&self, workbook: &str) -> std::io::Result<PathBuf> {
        // Ids come from routing tokens, but never let one escape the root.
        if workbook.is_empty() || !workbook.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid workbook id",
            ));
        }
        let dir = self.root.join(workbook);
        fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    fn read_versions(dir: &Path) -> Vec<VersionEntry> {
        fs::read(dir.join("versions/index.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Newest first.
    pub fn list_versions(&self, workbook: &str) -> std::io::Result<Vec<VersionEntry>> {
        let mut list = Self::read_versions(&self.dir(workbook)?);
        list.sort_by_key(|v| std::cmp::Reverse(v.seq));
        Ok(list)
    }

    fn write_versions(dir: &Path, list: &[VersionEntry]) -> std::io::Result<()> {
        let json = serde_json::to_vec(list).map_err(invalid)?;
        write_atomic(&dir.join("versions/index.json"), &json)
    }

    /// Record the current snapshot as a version. Saving the same seq again only
    /// updates its name.
    pub fn save_version(
        &self,
        workbook: &str,
        seq: u64,
        at: u64,
        name: Option<String>,
        by: Option<String>,
    ) -> std::io::Result<()> {
        let dir = self.dir(workbook)?;
        fs::create_dir_all(dir.join("versions"))?;
        let mut list = Self::read_versions(&dir);
        if let Some(v) = list.iter_mut().find(|v| v.seq == seq) {
            if name.is_some() {
                v.name = name;
                v.by = by;
            }
            return Self::write_versions(&dir, &list);
        }
        fs::copy(
            dir.join("snapshot.msgpack"),
            dir.join(format!("versions/{seq}.msgpack")),
        )?;
        list.push(VersionEntry { seq, at, name, by });
        list.sort_by_key(|v| v.seq);
        let unnamed: Vec<u64> = list
            .iter()
            .filter(|v| v.name.is_none())
            .map(|v| v.seq)
            .collect();
        if unnamed.len() > KEEP_UNNAMED_VERSIONS {
            for old in &unnamed[..unnamed.len() - KEEP_UNNAMED_VERSIONS] {
                let _ = fs::remove_file(dir.join(format!("versions/{old}.msgpack")));
                list.retain(|v| v.seq != *old);
            }
        }
        Self::write_versions(&dir, &list)
    }

    /// Name a version; false when there is no such version.
    pub fn name_version(&self, workbook: &str, seq: u64, name: &str) -> std::io::Result<bool> {
        let dir = self.dir(workbook)?;
        let mut list = Self::read_versions(&dir);
        let Some(v) = list.iter_mut().find(|v| v.seq == seq) else {
            return Ok(false);
        };
        v.name = Some(name.to_string());
        Self::write_versions(&dir, &list)?;
        Ok(true)
    }

    pub fn load_version(&self, workbook: &str, seq: u64) -> std::io::Result<Snapshot> {
        let dir = self.dir(workbook)?;
        let bytes = fs::read(dir.join(format!("versions/{seq}.msgpack")))?;
        let env: SnapshotEnvelope = rmp_serde::from_slice(&bytes).map_err(invalid)?;
        Ok(Snapshot {
            engine: env.engine,
            seq: env.seq,
            data: env.data,
            tables: env.tables,
        })
    }

    /// Copy a workbook's current state and its Data Tables into a new workbook.
    /// The caller flushes the source first, so the op-log is not copied.
    pub fn copy_workbook(&self, from: &str, to: &str) -> std::io::Result<()> {
        let (src, dst) = (self.dir(from)?, self.dir(to)?);
        if src.join("snapshot.msgpack").exists() {
            fs::copy(src.join("snapshot.msgpack"), dst.join("snapshot.msgpack"))?;
        }
        if let Ok(files) = fs::read_dir(src.join("tables")) {
            fs::create_dir_all(dst.join("tables"))?;
            for f in files {
                let f = f?;
                if f.file_type()?.is_file() {
                    fs::copy(f.path(), dst.join("tables").join(f.file_name()))?;
                }
            }
        }
        Ok(())
    }

    /// Delete a workbook and everything in it.
    pub fn purge(&self, workbook: &str) -> std::io::Result<()> {
        match fs::remove_dir_all(self.dir(workbook)?) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    pub fn load(&self, workbook: &str) -> std::io::Result<Loaded> {
        let dir = self.dir(workbook)?;
        let snapshot = match fs::read(dir.join("snapshot.msgpack")) {
            Ok(bytes) => {
                let env: SnapshotEnvelope = rmp_serde::from_slice(&bytes).map_err(invalid)?;
                Some(Snapshot {
                    engine: env.engine,
                    seq: env.seq,
                    data: env.data,
                    tables: env.tables,
                })
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
                let Some(op) = serde_json::from_str::<OpLine>(&line).ok().and_then(|op| {
                    Some(Op {
                        seq: op.seq,
                        diffs: B64.decode(op.diffs).ok()?,
                        tables: op.tables,
                    })
                }) else {
                    break;
                };
                if op.seq > after {
                    ops.push(op);
                }
            }
        }
        Ok(Loaded { snapshot, ops })
    }

    pub fn append(
        &self,
        workbook: &str,
        seq: u64,
        diffs: &[u8],
        tables: Option<&str>,
    ) -> std::io::Result<()> {
        let path = self.dir(workbook)?.join("oplog.jsonl");
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        let mut line = serde_json::to_vec(&OpLine {
            seq,
            diffs: B64.encode(diffs),
            tables: tables.map(str::to_string),
        })
        .map_err(invalid)?;
        line.push(b'\n');
        file.write_all(&line)?;
        file.sync_data()
    }

    /// Write a snapshot atomically, then drop op-log entries it already covers.
    pub fn write_snapshot(
        &self,
        workbook: &str,
        engine: &str,
        seq: u64,
        data: Vec<u8>,
        tables: Option<String>,
    ) -> std::io::Result<()> {
        let dir = self.dir(workbook)?;
        let bytes = rmp_serde::to_vec_named(&SnapshotEnvelope {
            v: 2,
            engine: engine.into(),
            seq,
            data,
            tables,
        })
        .map_err(invalid)?;
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

    fn op(raw: &str) -> Vec<u8> {
        raw.as_bytes().to_vec()
    }

    fn logged(seq: u64, raw: &str, tables: Option<&str>) -> Op {
        Op {
            seq,
            diffs: op(raw),
            tables: tables.map(str::to_string),
        }
    }

    #[test]
    fn ops_survive_reopen_and_snapshot_truncates_log() {
        let tmp = tempfile::tempdir().unwrap();
        let store = DirStore::new(tmp.path()).unwrap();
        for (seq, raw) in [(1, "a"), (2, "b")] {
            store.append("WB1", seq, &op(raw), None).unwrap();
        }
        store
            .append("WB1", 3, &op("c"), Some("{\"next_id\":1}"))
            .unwrap();
        let loaded = DirStore::new(tmp.path()).unwrap().load("WB1").unwrap();
        assert!(loaded.snapshot.is_none());
        assert_eq!(loaded.ops.len(), 3);

        store
            .write_snapshot("WB1", "test@1", 2, vec![9, 9], Some("{}".into()))
            .unwrap();
        let loaded = store.load("WB1").unwrap();
        let snap = loaded.snapshot.unwrap();
        assert_eq!(
            (
                snap.seq,
                snap.data,
                snap.engine.as_str(),
                snap.tables.as_deref()
            ),
            (2, vec![9, 9], "test@1", Some("{}"))
        );
        assert_eq!(loaded.ops, vec![logged(3, "c", Some("{\"next_id\":1}"))]);
    }

    #[test]
    fn torn_final_line_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let store = DirStore::new(tmp.path()).unwrap();
        store.append("WB2", 1, &op("x"), None).unwrap();
        let mut f = OpenOptions::new()
            .append(true)
            .open(tmp.path().join("WB2/oplog.jsonl"))
            .unwrap();
        f.write_all(br#"{"seq":2,"diffs":"QUJD"#).unwrap();
        assert_eq!(store.load("WB2").unwrap().ops, vec![logged(1, "x", None)]);
    }

    #[test]
    fn rejects_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let store = DirStore::new(tmp.path()).unwrap();
        assert!(store.load("../etc").is_err());
    }
}
