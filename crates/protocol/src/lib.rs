//! Sheet-channel wire protocol (BUILD-SPEC §5.1).
//!
//! Client -> server frames are JSON (`ClientMsg`), server -> client frames are
//! MessagePack (`ServerMsg`). Rows, columns and sheets are 0-based on the wire.

use serde::{Deserialize, Serialize};

/// Cells per tile edge; must match the client's tile cache.
pub const TILE_ROWS: u32 = 64;
pub const TILE_COLS: u32 = 16;

/// Bit flags describing a rendered cell's value.
pub mod kind {
    pub const NUMBER: u8 = 1;
    pub const ERROR: u8 = 2;
    pub const BOOLEAN: u8 = 4;
    /// A Data Table or filtered-range header cell: the client draws a column-menu button.
    pub const HEADER_BUTTON: u8 = 8;
    /// That header's column is filtered.
    pub const FILTERED: u8 = 16;
    /// That header's column is sorted (ascending unless SORT_DESC).
    pub const SORTED: u8 = 32;
    pub const SORT_DESC: u8 = 64;
}

/// Bit flags in `CellStyle::font`.
pub mod font {
    pub const BOLD: u8 = 1;
    pub const ITALIC: u8 = 2;
    pub const UNDERLINE: u8 = 4;
    pub const STRIKE: u8 = 8;
    pub const WRAP: u8 = 16;
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Range {
    pub sheet: u32,
    pub r0: u32,
    pub c0: u32,
    pub r1: u32,
    pub c1: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum BorderKind {
    All,
    Inner,
    Outer,
    Top,
    Right,
    Bottom,
    Left,
    None,
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
    // --- session (queries) ---
    /// First message on a connection; answered with `Welcome`.
    Hello,
    Ping,
    GetTiles {
        sheet: u32,
        tiles: Vec<[u32; 2]>,
    },
    /// Raw contents (formula or literal) of one cell, for the formula bar.
    GetCell {
        sheet: u32,
        row: u32,
        col: u32,
    },
    GetSheetMeta {
        sheet: u32,
    },
    /// Tab-separated display values, for the system clipboard. Also stores the
    /// range in the session's internal clipboard so a paste keeps formulas and styles.
    CopyRange {
        range: Range,
        cut: bool,
    },
    CtrlJump {
        sheet: u32,
        row: u32,
        col: u32,
        dir: Direction,
    },
    /// Next cell after (row, col), row-major, whose display text contains `text` (case-insensitive).
    Find {
        sheet: u32,
        row: u32,
        col: u32,
        text: String,
    },
    SelectionStats {
        range: Range,
    },
    ListNames,

    // --- mutations (op-logged; need edit rights) ---
    UpdateCell {
        sheet: u32,
        row: u32,
        col: u32,
        raw: String,
    },
    /// Paste tab-separated text (e.g. from Excel) with its top-left at (row, col).
    PasteText {
        sheet: u32,
        row: u32,
        col: u32,
        text: String,
    },
    /// Paste the session's internal clipboard with its top-left at (row, col).
    PasteInternal {
        sheet: u32,
        row: u32,
        col: u32,
    },
    ClearRange {
        range: Range,
        formats: bool,
    },
    /// Fill `source` down/up to `to_row` or right/left to `to_col` (exactly one is set).
    Fill {
        source: Range,
        to_row: Option<u32>,
        to_col: Option<u32>,
    },
    InsertRows {
        sheet: u32,
        row: u32,
        count: u32,
    },
    DeleteRows {
        sheet: u32,
        row: u32,
        count: u32,
    },
    InsertCols {
        sheet: u32,
        col: u32,
        count: u32,
    },
    DeleteCols {
        sheet: u32,
        col: u32,
        count: u32,
    },
    Undo,
    Redo,
    /// IronCalc style path and value, e.g. ("font.b", "true"), ("num_fmt", "#,##0.00"),
    /// ("fill.color", "#FFF2CC"), ("alignment.horizontal", "center").
    SetStyle {
        range: Range,
        path: String,
        value: String,
    },
    SetBorder {
        range: Range,
        kind: BorderKind,
        style: String,
        color: String,
    },
    Merge {
        range: Range,
    },
    Unmerge {
        range: Range,
    },
    SetColWidth {
        sheet: u32,
        c0: u32,
        c1: u32,
        width: f64,
    },
    SetRowHeight {
        sheet: u32,
        r0: u32,
        r1: u32,
        height: f64,
    },
    Freeze {
        sheet: u32,
        rows: u32,
        cols: u32,
    },
    SetGridlines {
        sheet: u32,
        show: bool,
    },
    ReplaceAll {
        sheet: u32,
        find: String,
        replace: String,
    },
    AddSheet,
    RenameSheet {
        sheet: u32,
        name: String,
    },
    DeleteSheet {
        sheet: u32,
    },
    MoveSheet {
        sheet: u32,
        to: u32,
    },
    DuplicateSheet {
        sheet: u32,
    },
    SetSheetColor {
        sheet: u32,
        color: String,
    },
    SetSheetHidden {
        sheet: u32,
        hidden: bool,
    },
    CreateName {
        name: String,
        scope: Option<u32>,
        formula: String,
    },
    UpdateName {
        name: String,
        scope: Option<u32>,
        new_name: String,
        new_scope: Option<u32>,
        formula: String,
    },
    DeleteName {
        name: String,
        scope: Option<u32>,
    },

    // --- import (BUILD-SPEC §5.1 Import group; the file is uploaded over HTTP first) ---
    /// Parse the start of an uploaded file with `options` and return columns, types and sample rows.
    ImportPreview {
        import_id: String,
        #[serde(default)]
        options: ImportOptions,
    },
    /// Discard an uploaded file that will not be imported.
    CancelImport {
        import_id: String,
    },
    /// Import an uploaded file. Importing to the anchor of an earlier import replaces it,
    /// so formulas and computed columns that depend on it recompute.
    FinalizeImport {
        import_id: String,
        #[serde(default)]
        options: ImportOptions,
        dest: ImportDest,
        mode: ImportMode,
        /// Shown as the table or sheet name; usually the file name.
        name: String,
    },

    // --- data (ranges and Data Tables) ---
    /// Distinct values (with counts) of one column, for filter menus.
    DistinctValues {
        target: DataTarget,
        col: u32,
        #[serde(default)]
        search: Option<String>,
        #[serde(default = "default_distinct_limit")]
        limit: u32,
    },
    /// Sort the rows of a range by one or more of its columns (absolute column indices).
    SortRange {
        range: Range,
        keys: Vec<SortKey>,
        header: bool,
    },
    /// Set (or with `None`, clear) the filter on one column. For a range this turns the
    /// range into a filtered range (row 0 is the header) and hides rows that fail.
    SetFilter {
        target: DataTarget,
        col: u32,
        filter: Option<ColumnFilter>,
    },
    /// Remove every filter (and, for a range, its filtered-range state).
    ClearFilters {
        target: DataTarget,
    },
    /// Sort a Data Table's view by table column indices; an empty list clears the sort.
    SortTable {
        table: String,
        keys: Vec<SortKey>,
    },
    AddComputedColumn {
        table: String,
        name: String,
        expr: String,
    },
    UpdateComputedColumn {
        table: String,
        col: u32,
        name: String,
        expr: String,
    },
    /// Delete a computed column (source columns can only be hidden).
    DeleteTableColumn {
        table: String,
        col: u32,
    },
    SetTableColumnHidden {
        table: String,
        col: u32,
        hidden: bool,
    },
    RenameTable {
        table: String,
        name: String,
    },
    DeleteTable {
        table: String,
    },
    /// Write the table's current view into ordinary cells at its anchor and remove the table.
    ExplodeTable {
        table: String,
    },
    /// Delete rows whose values in `cols` repeat an earlier row. Range: absolute columns;
    /// table: table column indices (empty means all columns).
    RemoveDuplicates {
        target: DataTarget,
        cols: Vec<u32>,
        header: bool,
    },
    /// Split the cells of a one-column range on `delimiter` into the columns to its right.
    TextToColumns {
        range: Range,
        delimiter: String,
    },
}

fn default_distinct_limit() -> u32 {
    1000
}

impl Action {
    /// Whether the action changes workbook state (and so is op-logged and needs edit rights).
    pub fn is_mutation(&self) -> bool {
        !matches!(
            self,
            Action::Hello
                | Action::Ping
                | Action::GetTiles { .. }
                | Action::GetCell { .. }
                | Action::GetSheetMeta { .. }
                | Action::CopyRange { .. }
                | Action::CtrlJump { .. }
                | Action::Find { .. }
                | Action::SelectionStats { .. }
                | Action::ListNames
                | Action::ImportPreview { .. }
                | Action::CancelImport { .. }
                | Action::DistinctValues { .. }
        )
    }

    /// Queries that still need edit rights (they act on an upload in progress).
    pub fn needs_edit(&self) -> bool {
        self.is_mutation()
            || matches!(
                self,
                Action::ImportPreview { .. } | Action::CancelImport { .. }
            )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImportOptions {
    #[serde(default = "yes")]
    pub header: bool,
    /// One character, or None to autodetect.
    #[serde(default)]
    pub separator: Option<String>,
    #[serde(default)]
    pub quote: Option<String>,
    #[serde(default)]
    pub skip_rows: u32,
}

fn yes() -> bool {
    true
}

impl Default for ImportOptions {
    fn default() -> Self {
        ImportOptions {
            header: true,
            separator: None,
            quote: None,
            skip_rows: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum ImportDest {
    NewSheet,
    Cell { sheet: u32, row: u32, col: u32 },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum ImportMode {
    Cells,
    Table,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum DataTarget {
    Range { range: Range },
    Table { table: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct SortKey {
    pub col: u32,
    pub desc: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum FilterOp {
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    Blank,
    NotBlank,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum ColumnFilter {
    /// Keep rows whose display value is one of `values` ("" stands for blank).
    Values {
        values: Vec<String>,
    },
    Condition {
        op: FilterOp,
        value: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ColumnInfo {
    pub name: String,
    /// "integer" | "number" | "boolean" | "date" | "datetime" | "text"
    pub dtype: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImportPreview {
    /// "csv" | "jsonl" | "parquet" | "xlsx"
    pub format: String,
    /// The separator used (detected or given), for delimited text.
    pub separator: Option<String>,
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<String>>,
    /// Exact for Parquet and XLSX, estimated from the sample for text formats.
    pub total_rows: Option<u64>,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TableColumnInfo {
    pub name: String,
    pub dtype: String,
    /// The formula of a computed column.
    pub expr: Option<String>,
    pub hidden: bool,
    pub filter: Option<ColumnFilter>,
    /// Some(desc) when the view is sorted by this column.
    pub sort: Option<bool>,
}

/// A Data Table: header row at (row, col), then `rows` rows of its current view.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TableInfo {
    pub id: String,
    pub name: String,
    pub sheet: u32,
    pub row: u32,
    pub col: u32,
    /// Rows in the filtered view.
    pub rows: u64,
    /// Rows in the source data.
    pub total_rows: u64,
    /// All columns, hidden ones included; only visible ones occupy sheet columns.
    pub columns: Vec<TableColumnInfo>,
    pub source: String,
}

/// A filtered range: row r0 is the header; filters are keyed by absolute column.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RangeFilterInfo {
    pub range: Range,
    pub filters: Vec<(u32, ColumnFilter)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SheetInfo {
    pub id: u32,
    pub name: String,
    pub color: Option<String>,
    pub hidden: bool,
}

/// One border edge: (style name, "#RRGGBB").
pub type Edge = Option<(String, String)>;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct CellStyle {
    /// `font::*` flags.
    pub font: u8,
    /// "#RRGGBB"; None means default.
    pub color: Option<String>,
    pub fill: Option<String>,
    /// "left" | "center" | "right"; None means by value type.
    pub align: Option<String>,
    /// Point size when not the default.
    pub size: Option<i32>,
    pub top: Option<(String, String)>,
    pub right: Option<(String, String)>,
    pub bottom: Option<(String, String)>,
    pub left: Option<(String, String)>,
}

/// One rendered cell: (index within tile, display text, `kind::*` flags, index into `Tile::styles`).
pub type TileCell = (u32, String, u8, u16);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Tile {
    pub tr: u32,
    pub tc: u32,
    pub cells: Vec<TileCell>,
    pub styles: Vec<CellStyle>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SheetMeta {
    pub sheet: u32,
    pub frozen_rows: u32,
    pub frozen_cols: u32,
    pub default_col_width: f64,
    pub default_row_height: f64,
    /// (column, width px) where different from the default.
    pub col_widths: Vec<(u32, f64)>,
    pub row_heights: Vec<(u32, f64)>,
    pub merges: Vec<Range>,
    pub show_grid: bool,
    /// Rows the grid should allow: Excel's limit, or more when a Data Table extends past it.
    pub row_count: u64,
    pub tables: Vec<TableInfo>,
    pub filters: Vec<RangeFilterInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NameInfo {
    pub name: String,
    pub scope: Option<u32>,
    pub formula: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "k")]
pub enum Reply {
    Ok,
    Pong,
    Tiles {
        sheet: u32,
        tiles: Vec<Tile>,
    },
    Cell {
        sheet: u32,
        row: u32,
        col: u32,
        raw: String,
    },
    SheetMeta {
        meta: SheetMeta,
    },
    Text {
        text: String,
    },
    Position {
        sheet: u32,
        row: u32,
        col: u32,
    },
    NotFound,
    Stats {
        count: u64,
        numbers: u64,
        sum: f64,
        min: Option<f64>,
        max: Option<f64>,
    },
    Names {
        names: Vec<NameInfo>,
    },
    ImportPreview {
        preview: ImportPreview,
    },
    /// Where an import landed: the sheet and the extent written (header included).
    Imported {
        sheet: u32,
        row: u32,
        col: u32,
        rows: u64,
        cols: u32,
        table: Option<String>,
    },
    Distinct {
        /// (display value, rows) sorted by value; "" is blank.
        values: Vec<(String, u64)>,
        /// Distinct values in total (before `limit`).
        total: u64,
    },
    Removed {
        removed: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t")]
pub enum ServerMsg {
    Welcome {
        seq: u64,
        sheets: Vec<SheetInfo>,
        role: String,
        can_undo: bool,
        can_redo: bool,
    },
    Reply {
        req_id: u64,
        seq: u64,
        body: Reply,
    },
    Error {
        req_id: u64,
        code: String,
        message: String,
    },
    /// Broadcast after any mutation: cached tiles and sheet meta older than `seq` are stale.
    Changed {
        seq: u64,
        sheets: Vec<SheetInfo>,
        can_undo: bool,
        can_redo: bool,
    },
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
        let msg = ClientMsg::parse(
            r#"{"reqId":7,"action":{"type":"UpdateCell","sheet":0,"row":1,"col":2,"raw":"=1+1"}}"#,
        )
        .unwrap();
        assert_eq!(msg.req_id, 7);
        assert!(msg.action.is_mutation());
        assert_eq!(
            msg.action,
            Action::UpdateCell {
                sheet: 0,
                row: 1,
                col: 2,
                raw: "=1+1".into()
            }
        );
        assert!(
            !ClientMsg::parse(r#"{"reqId":1,"action":{"type":"Hello"}}"#)
                .unwrap()
                .action
                .is_mutation()
        );
        let fill = ClientMsg::parse(r#"{"reqId":2,"action":{"type":"Fill","source":{"sheet":0,"r0":0,"c0":0,"r1":0,"c1":1},"to_row":9,"to_col":null}}"#).unwrap();
        assert!(fill.action.is_mutation());
        assert!(!ClientMsg::parse(
            r#"{"reqId":3,"action":{"type":"CtrlJump","sheet":0,"row":0,"col":0,"dir":"Down"}}"#
        )
        .unwrap()
        .action
        .is_mutation());
    }

    #[test]
    fn server_msgpack_round_trip() {
        let msg = ServerMsg::Reply {
            req_id: 3,
            seq: 9,
            body: Reply::Tiles {
                sheet: 0,
                tiles: vec![Tile {
                    tr: 0,
                    tc: 1,
                    cells: vec![(5, "42".into(), kind::NUMBER, 0)],
                    styles: vec![CellStyle::default()],
                }],
            },
        };
        assert_eq!(ServerMsg::decode(&msg.encode()).unwrap(), msg);
    }
}
