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
    /// The cell has a dropdown list (data validation). Together with HEADER_BUTTON: a
    /// pivot group toggle, collapsed when FILTERED is also set.
    pub const DROPDOWN: u8 = 128;
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

    // --- analysis objects (M3; BUILD-SPEC §5.1 Objects group) ---
    /// Create a pivot table; `new_sheet` puts it at A1 of a new sheet (the spec's
    /// anchor is then ignored). Replies `Created`.
    CreatePivot {
        spec: PivotSpec,
        #[serde(default)]
        new_sheet: bool,
    },
    UpdatePivot {
        spec: PivotSpec,
    },
    /// Columns of a pivot source, for the fields pane.
    GetFields {
        source: DataTarget,
    },
    CreateChart {
        spec: ChartSpec,
    },
    UpdateChart {
        spec: ChartSpec,
    },
    /// Evaluated series of a chart (BUILD-SPEC §5.2 serves this over HTTP; we use the socket).
    GetChart {
        id: String,
    },
    CreateSlicer {
        spec: SlicerSpec,
    },
    UpdateSlicer {
        spec: SlicerSpec,
    },
    /// Copy the source rows behind a pivot cell to a Data Table on a new sheet.
    DrillDown {
        sheet: u32,
        row: u32,
        col: u32,
    },
    /// Delete a pivot, chart, slicer or validation rule.
    DeleteObject {
        id: String,
    },
    /// Create (empty id) or replace a data-validation dropdown rule.
    SetValidation {
        spec: ValidationSpec,
    },
    /// Allowed values for a cell with a validation rule.
    GetChoices {
        sheet: u32,
        row: u32,
        col: u32,
    },
    AddCondFormat {
        range: Range,
        rule: CondRule,
        #[serde(default)]
        style: CondStyle,
    },
    DeleteCondFormat {
        sheet: u32,
        index: u32,
    },
    ListCondFormats {
        sheet: u32,
    },

    // --- pivot groups (M3) ---
    /// Collapse or expand the group of rows sharing these leading row-field keys.
    TogglePivotGroup {
        id: String,
        key: Vec<String>,
    },

    // --- collaboration (M4) ---
    /// This session's selection and view; broadcast to the other sessions.
    Presence {
        sheet: u32,
        selection: Range,
        /// Top-left cell in view, for followers.
        view: [u32; 2],
        #[serde(default)]
        following: Option<u64>,
    },
    /// `author` and `at` are filled in by the server.
    AddComment {
        sheet: u32,
        row: u32,
        col: u32,
        text: String,
        #[serde(default)]
        author: String,
        #[serde(default)]
        at: u64,
    },
    ReplyComment {
        id: String,
        text: String,
        #[serde(default)]
        author: String,
        #[serde(default)]
        at: u64,
    },
    ResolveComment {
        id: String,
        resolved: bool,
    },
    DeleteComment {
        id: String,
    },
    // --- Python (M5) ---
    GetCode,
    /// Save the module, run it, and make its functions usable in formulas.
    RunCode {
        source: String,
    },
    /// Internal: the saved module, once a Run has happened.
    SaveCode {
        source: String,
    },
    SetExecuteOnWake {
        on: bool,
    },
    ListVersions,
    /// Save the current state as a version, named when `name` is given.
    CreateVersion {
        #[serde(default)]
        name: Option<String>,
    },
    NameVersion {
        seq: u64,
        name: String,
    },
    RestoreVersion {
        seq: u64,
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
                | Action::GetFields { .. }
                | Action::GetChart { .. }
                | Action::GetChoices { .. }
                | Action::ListCondFormats { .. }
                | Action::Presence { .. }
                | Action::GetCode
                | Action::RunCode { .. }
                | Action::ListVersions
                | Action::CreateVersion { .. }
                | Action::NameVersion { .. }
                | Action::RestoreVersion { .. }
        )
    }

    /// Queries that still need edit rights (they act on an upload in progress).
    pub fn needs_edit(&self) -> bool {
        self.is_mutation()
            || matches!(
                self,
                Action::ImportPreview { .. }
                    | Action::CancelImport { .. }
                    | Action::RunCode { .. }
                    | Action::CreateVersion { .. }
                    | Action::NameVersion { .. }
                    | Action::RestoreVersion { .. }
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Agg {
    Sum,
    Count,
    CountUnique,
    Avg,
    Min,
    Max,
    Median,
    Percentile,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum DateGroup {
    Year,
    Quarter,
    Month,
    Day,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PivotField {
    pub field: String,
    #[serde(default)]
    pub group: Option<DateGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PivotValue {
    pub field: String,
    pub agg: Agg,
    /// For `Percentile`: 0..=1 (default 0.9).
    #[serde(default)]
    pub percentile: Option<f64>,
}

/// A pivot table (PRD FR-12, E27), anchored at (sheet, row, col). Its output is
/// read-only and recomputed when the source changes. Fields are named by column.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PivotSpec {
    #[serde(default)]
    pub id: String,
    pub sheet: u32,
    pub row: u32,
    pub col: u32,
    pub source: DataTarget,
    #[serde(default)]
    pub rows: Vec<PivotField>,
    #[serde(default)]
    pub columns: Vec<PivotField>,
    #[serde(default)]
    pub values: Vec<PivotValue>,
    #[serde(default)]
    pub filters: Vec<(String, ColumnFilter)>,
    #[serde(default = "yes")]
    pub totals: bool,
    /// Leading row-field keys of the collapsed groups.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub collapsed: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PivotInfo {
    pub spec: PivotSpec,
    /// Output size, header and total rows included.
    pub rows: u64,
    pub cols: u32,
    pub error: Option<String>,
    /// Columns of the source.
    pub fields: Vec<ColumnInfo>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ChartKind {
    Bar,
    Column,
    Line,
    Area,
    Scatter,
    Pie,
    Histogram,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum Axis {
    #[default]
    Left,
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChartSeries {
    /// One row or column of cells; None once the cells were deleted (#REF!).
    pub range: Option<Range>,
    #[serde(default)]
    pub name: Option<String>,
    /// Overrides the chart's kind for this series (combo charts).
    #[serde(default)]
    pub kind: Option<ChartKind>,
    #[serde(default)]
    pub axis: Axis,
}

/// A chart (PRD FR-13, E23): every series is a reference, kept pointing at the same
/// cells when rows or columns are inserted or deleted. Anchored at a cell, sized in px.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChartSpec {
    #[serde(default)]
    pub id: String,
    pub sheet: u32,
    pub row: u32,
    pub col: u32,
    pub w: u32,
    pub h: u32,
    pub kind: ChartKind,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub x: Option<Range>,
    pub series: Vec<ChartSeries>,
    /// Histogram buckets (default: Sturges).
    #[serde(default)]
    pub bins: Option<u32>,
    #[serde(default)]
    pub stacked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SeriesData {
    pub name: String,
    pub kind: ChartKind,
    pub axis: Axis,
    pub values: Vec<Option<f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChartData {
    /// Category labels (or histogram bucket labels).
    pub x: Vec<String>,
    pub series: Vec<SeriesData>,
    /// References as A1 text: x first (empty when none), then each series.
    pub refs: Vec<String>,
    pub errors: Vec<String>,
}

/// A slicer (PRD FR-14, E28): a chip that edits one column filter of a Data Table or
/// filtered range. Pivots and charts reading that source follow it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SlicerSpec {
    #[serde(default)]
    pub id: String,
    pub sheet: u32,
    pub row: u32,
    pub col: u32,
    pub target: DataTarget,
    /// Table column index, or absolute sheet column for a range.
    pub column: u32,
    #[serde(default)]
    pub title: String,
}

/// A dropdown list on a range (data validation).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ValidationSpec {
    #[serde(default)]
    pub id: String,
    pub range: Range,
    /// Allowed values, or take them from `source` cells.
    #[serde(default)]
    pub values: Vec<String>,
    #[serde(default)]
    pub source: Option<Range>,
    /// Reject other values (otherwise the list is only a suggestion).
    #[serde(default = "yes")]
    pub strict: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum CondOp {
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
    Between,
    NotBetween,
}

/// Conditional-format rule kinds offered by the UI (mapped onto IronCalc's rules).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum CondRule {
    CellIs {
        op: CondOp,
        value: String,
        #[serde(default)]
        value2: Option<String>,
    },
    TextContains {
        value: String,
    },
    Blanks,
    NotBlanks,
    Duplicates,
    Top {
        rank: u32,
        #[serde(default)]
        bottom: bool,
        #[serde(default)]
        percent: bool,
    },
    Average {
        #[serde(default)]
        below: bool,
    },
    Formula {
        formula: String,
    },
    ColorScale {
        min: String,
        #[serde(default)]
        mid: Option<String>,
        max: String,
    },
    DataBar {
        color: String,
    },
    /// Three icons by the cell's percent rank in the range (Excel's 67/33 split).
    IconSet {
        set: IconSetKind,
        #[serde(default)]
        reverse: bool,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum IconSetKind {
    Arrows,
    TrafficLights,
    Flags,
    Symbols,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct CondStyle {
    #[serde(default)]
    pub fill: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub bold: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CondFormatInfo {
    pub index: u32,
    /// A1 ranges, e.g. "B2:B100".
    pub range: String,
    pub summary: String,
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
    /// Conditional-format data bar: (fill in thousandths of the cell width, "#RRGGBB").
    #[serde(default)]
    pub bar: Option<(u16, String)>,
    /// Conditional-format icon: ("up" | "right" | "down" | "circle" | "flag" | "check" |
    /// "exclamation" | "cross", "#RRGGBB").
    #[serde(default)]
    pub icon: Option<(String, String)>,
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
    pub pivots: Vec<PivotInfo>,
    pub charts: Vec<ChartSpec>,
    pub slicers: Vec<SlicerInfo>,
    pub validations: Vec<ValidationSpec>,
    pub comments: Vec<Comment>,
}

/// A comment thread pinned to a cell.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Comment {
    pub id: String,
    pub sheet: u32,
    pub row: u32,
    pub col: u32,
    pub author: String,
    /// Milliseconds since the epoch.
    pub at: u64,
    pub text: String,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default)]
    pub replies: Vec<CommentReply>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CommentReply {
    pub author: String,
    pub at: u64,
    pub text: String,
}

/// The workbook's Python module.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CodeState {
    pub source: String,
    pub execute_on_wake: bool,
}

impl Default for CodeState {
    fn default() -> Self {
        CodeState {
            source: String::new(),
            execute_on_wake: true,
        }
    }
}

/// A saved state of the workbook.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VersionInfo {
    pub seq: u64,
    pub at: u64,
    pub name: Option<String>,
    pub by: Option<String>,
}

/// Another session on the same workbook.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Peer {
    pub id: u64,
    pub name: String,
    pub color: String,
    pub sheet: u32,
    pub selection: Option<Range>,
    pub view: [u32; 2],
    pub following: Option<u64>,
}

/// A slicer with the state it shows: its column's name and current filter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SlicerInfo {
    pub spec: SlicerSpec,
    pub column_name: String,
    pub filter: Option<ColumnFilter>,
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
    /// Id of a new pivot, chart, slicer or validation rule.
    Created {
        id: String,
        sheet: u32,
    },
    Fields {
        columns: Vec<ColumnInfo>,
    },
    Chart {
        data: ChartData,
    },
    Choices {
        values: Vec<String>,
        strict: bool,
    },
    CondFormats {
        list: Vec<CondFormatInfo>,
    },
    Versions {
        list: Vec<VersionInfo>,
    },
    Code {
        source: String,
        execute_on_wake: bool,
    },
    CodeRun {
        output: String,
        error: Option<String>,
        functions: Vec<String>,
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
    /// Who is here; `you` is the receiving session's peer id.
    Presence {
        you: u64,
        peers: Vec<Peer>,
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
