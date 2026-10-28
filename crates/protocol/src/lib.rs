//! Sheet-channel wire protocol (BUILD-SPEC §5.1).
//!
//! Client -> server frames are JSON (`ClientMsg`), server -> client frames are
//! MessagePack (`ServerMsg`). Rows and columns are 0-based on the wire.

use serde::{Deserialize, Serialize};

/// Cells per tile edge; must match the client's tile cache.
pub const TILE_ROWS: u32 = 64;
pub const TILE_COLS: u32 = 16;

/// Bit flags on a rendered cell.
pub mod flags {
    pub const NUMBER: u8 = 1;
    pub const BOLD: u8 = 2;
    pub const ERROR: u8 = 4;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClientMsg {
    #[serde(rename = "reqId")]
    pub req_id: u64,
    pub action: Action,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum Action {
    /// First message on a connection; answered with `Welcome`.
    Hello,
    Ping,
    /// Rendered tiles for one sheet, answered with `Tiles`.
    GetTiles { sheet: u32, tiles: Vec<[u32; 2]> },
    /// Raw contents (formula or literal) of one cell, for the formula bar.
    GetCell { sheet: u32, row: u32, col: u32 },
    /// Set a cell from user input. An empty `raw` clears the cell.
    UpdateCell { sheet: u32, row: u32, col: u32, raw: String },
}

impl Action {
    /// Whether the action changes workbook state (and so is op-logged and needs edit rights).
    pub fn is_mutation(&self) -> bool {
        matches!(self, Action::UpdateCell { .. })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SheetInfo {
    pub id: u32,
    pub name: String,
}

/// One rendered cell inside a tile: (index within tile, display text, flags).
pub type TileCell = (u32, String, u8);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Tile {
    pub tr: u32,
    pub tc: u32,
    pub cells: Vec<TileCell>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t")]
pub enum ServerMsg {
    Welcome { seq: u64, sheets: Vec<SheetInfo>, role: String },
    Ack { req_id: u64, seq: u64 },
    Error { req_id: u64, code: String, message: String },
    Tiles { req_id: u64, seq: u64, sheet: u32, tiles: Vec<Tile> },
    Cell { req_id: u64, sheet: u32, row: u32, col: u32, raw: String },
    /// Broadcast after any mutation: cached tiles older than `seq` are stale.
    Changed { seq: u64 },
    Pong { req_id: u64 },
}

impl ServerMsg {
    pub fn encode(&self) -> Vec<u8> {
        rmp_serde::to_vec_named(self).expect("ServerMsg always encodes")
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, rmp_serde::decode::Error> {
        rmp_serde::from_slice(bytes)
    }
}

impl ClientMsg {
    pub fn parse(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_json_shape() {
        let msg = ClientMsg::parse(r#"{"reqId":7,"action":{"type":"UpdateCell","sheet":0,"row":1,"col":2,"raw":"=1+1"}}"#).unwrap();
        assert_eq!(msg.req_id, 7);
        assert!(msg.action.is_mutation());
        assert_eq!(msg.action, Action::UpdateCell { sheet: 0, row: 1, col: 2, raw: "=1+1".into() });
        assert!(!ClientMsg::parse(r#"{"reqId":1,"action":{"type":"Hello"}}"#).unwrap().action.is_mutation());
    }

    #[test]
    fn server_msgpack_round_trip() {
        let msg = ServerMsg::Tiles {
            req_id: 3,
            seq: 9,
            sheet: 0,
            tiles: vec![Tile { tr: 0, tc: 1, cells: vec![(5, "42".into(), flags::NUMBER)] }],
        };
        assert_eq!(ServerMsg::decode(&msg.encode()).unwrap(), msg);
    }
}
