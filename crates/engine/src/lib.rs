//! Workbook state on top of IronCalc's `UserModel` (undo/redo, ranges, styles,
//! sheets, names). Owned by exactly one actor thread (BUILD-SPEC §3), so it needs
//! no locking.
//!
//! Every mutation is captured as IronCalc's own diff list (`flush_send_queue`).
//! The op-log stores those diffs rather than actions, so replay is exact even for
//! undo/redo, whose history is not part of a snapshot.
//!
//! Data Tables (M2) live beside the cells in a `TableStore`. A mutation that changes
//! them also yields the store's new manifest, which the op-log records with the
//! diffs. Undo covers both through one history: each step remembers how many
//! IronCalc undo entries it made and, if tables changed, the manifest before it.

use ironcalc_base::cell::CellValue;
use ironcalc_base::expressions::types::Area;
use ironcalc_base::types::{BorderItem, CellType, Color, HorizontalAlignment, Style};
use ironcalc_base::worksheet::NavigationDirection;
use ironcalc_base::{BorderArea, UserModel, COLUMN_WIDTH_FACTOR, ROW_HEIGHT_FACTOR};
use protocol::{
    font, kind, Action, BorderKind, CellStyle, Direction, NameInfo, Range, Reply, SheetInfo,
    SheetMeta, Tile, TILE_COLS, TILE_ROWS,
};
use std::collections::HashMap;
use std::path::PathBuf;
use tables::TableStore;

mod data;
mod mirror;
mod objects;
mod structured;

/// Engine identity recorded in snapshots (S1 obligation A3): IronCalc's bitcode
/// layout is version-coupled, so a snapshot must say which engine wrote it.
pub const ENGINE_VERSION: &str = "ironcalc_base@0.9.1";

/// Excel's limits; IronCalc rows and columns are 1-based.
pub const MAX_ROWS: u32 = 1_048_576;
pub const MAX_COLS: u32 = 16_384;
/// Cap on per-column overrides reported in sheet meta (whole-sheet width changes stay bounded).
const MAX_SIZE_OVERRIDES: usize = 20_000;

pub struct Workbook {
    um: UserModel<'static>,
    pub seq: u64,
    /// Encoding of an empty diff queue, to recognise no-op mutations.
    empty_queue: Vec<u8>,
    tables: TableStore,
    /// The workbook's directory: `tables/` (Parquet) and `staging/` (uploads).
    dir: PathBuf,
    undo: Vec<Step>,
    redo: Vec<Step>,
    /// IronCalc undo entries made by the mutation in progress, when not exactly one.
    engine_steps: Option<u32>,
    /// Bumped whenever cells change, so pivots over ranges know to recompute.
    cells_version: u64,
    pivot_cache: objects::PivotCache,
    /// Table and pivot cells that formulas reference, written into IronCalc.
    mirror: mirror::Mirror,
}

/// One user-visible undo step.
struct Step {
    /// IronCalc undo entries to undo/redo together.
    engine: u32,
    /// Table manifest to swap in (the state on the other side of this step).
    tables: Option<String>,
}

/// What a snapshot persists: IronCalc's bytes and the table manifest.
pub struct EngineSnapshot {
    pub data: Vec<u8>,
    pub tables: String,
}

/// A session's internal clipboard: IronCalc's clipboard as JSON (its fields are
/// crate-private but serde-visible) plus whether it came from a cut.
pub struct SessionClipboard {
    source_sheet: u32,
    source_range: (i32, i32, i32, i32),
    data: serde_json::Value,
    cut: bool,
}

pub enum Outcome {
    Query(Reply),
    /// The workbook changed: `diffs` (and `tables`, when Data Tables changed) is what
    /// the op-log persists.
    Mutated {
        reply: Reply,
        seq: u64,
        diffs: Vec<u8>,
        tables: Option<String>,
    },
    /// A mutation that changed nothing (e.g. undo with an empty history).
    Unchanged(Reply),
}

#[derive(Debug, PartialEq)]
pub enum EngineError {
    BadInput(String),
    OutOfRange,
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::BadInput(m) => write!(f, "{m}"),
            EngineError::OutOfRange => write!(f, "cell or range out of bounds"),
        }
    }
}

type Result<T> = std::result::Result<T, EngineError>;

fn bad(e: String) -> EngineError {
    EngineError::BadInput(e)
}

fn cell(row: u32, col: u32) -> Result<(i32, i32)> {
    if row < MAX_ROWS && col < MAX_COLS {
        Ok((row as i32 + 1, col as i32 + 1))
    } else {
        Err(EngineError::OutOfRange)
    }
}

fn area(r: &Range) -> Result<Area> {
    if r.r0 > r.r1 || r.c0 > r.c1 {
        return Err(bad("range is inverted".into()));
    }
    cell(r.r1, r.c1)?;
    Ok(Area {
        sheet: r.sheet,
        row: r.r0 as i32 + 1,
        column: r.c0 as i32 + 1,
        width: (r.c1 - r.c0 + 1) as i32,
        height: (r.r1 - r.r0 + 1) as i32,
    })
}

fn rgb(um: &UserModel, color: &Color) -> Option<String> {
    match color {
        Color::None => None,
        c => Some(um.resolve_color(c)).filter(|s| !s.is_empty()),
    }
}

impl Workbook {
    fn wrap(mut um: UserModel<'static>, seq: u64, dir: PathBuf) -> Self {
        um.flush_send_queue();
        let empty_queue = um.flush_send_queue();
        Workbook {
            um,
            seq,
            empty_queue,
            tables: TableStore::new(tables::tables_dir(&dir)),
            dir,
            undo: Vec::new(),
            redo: Vec::new(),
            engine_steps: None,
            cells_version: 0,
            pivot_cache: Default::default(),
            mirror: Default::default(),
        }
    }

    /// An empty workbook keeping its files in `dir`.
    pub fn new_in(dir: impl Into<PathBuf>) -> Self {
        Self::wrap(
            UserModel::new_empty("workbook", "en", "UTC", "en").expect("en/UTC are valid"),
            0,
            dir.into(),
        )
    }

    /// An empty workbook with a private scratch directory (tests and tools).
    pub fn new_empty() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Self::new_in(std::env::temp_dir().join(format!("gridzero-wb-{}-{n}", std::process::id())))
    }

    pub fn from_snapshot(
        bytes: &[u8],
        tables: Option<&str>,
        seq: u64,
        dir: impl Into<PathBuf>,
    ) -> std::result::Result<Self, String> {
        let mut um = UserModel::from_bytes(bytes, "en")?;
        um.evaluate();
        let mut wb = Self::wrap(um, seq, dir.into());
        if let Some(json) = tables {
            wb.tables.set_manifest_json(json)?;
            if wb.sync_mirror() {
                wb.um.evaluate();
            }
        }
        Ok(wb)
    }

    /// Snapshots leave out mirrored table and pivot cells: they are rebuilt on load.
    pub fn to_snapshot(&mut self) -> EngineSnapshot {
        self.without_mirror(|wb| EngineSnapshot {
            data: wb.um.to_bytes(),
            tables: wb.tables.manifest_json(),
        })
    }

    pub fn dir(&self) -> &std::path::Path {
        &self.dir
    }

    /// Apply logged diffs (and the table manifest, if the op changed tables) during
    /// rehydrate. Call `evaluate` once after a batch.
    pub fn replay(
        &mut self,
        seq: u64,
        diffs: &[u8],
        tables: Option<&str>,
    ) -> std::result::Result<(), String> {
        if !diffs.is_empty() {
            self.clear_mirror();
        }
        self.um.pause_evaluation();
        let result = if diffs.is_empty() {
            Ok(())
        } else {
            self.um.apply_external_diffs(diffs)
        };
        self.um.resume_evaluation();
        self.seq = seq;
        self.cells_version += 1;
        self.um.flush_send_queue();
        result?;
        if let Some(json) = tables {
            self.tables.set_manifest_json(json)?;
        }
        Ok(())
    }

    pub fn evaluate(&mut self) {
        self.sync_mirror();
        self.um.evaluate();
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Undo (or redo) one history step; Ok(false) when there is nothing to do.
    fn step(&mut self, undo: bool) -> Result<bool> {
        let stack = if undo { &mut self.undo } else { &mut self.redo };
        let Some(mut step) = stack.pop() else {
            return Ok(false);
        };
        for _ in 0..step.engine {
            if undo {
                self.um.undo().map_err(bad)?;
            } else {
                self.um.redo().map_err(bad)?;
            }
        }
        if let Some(json) = step.tables.take() {
            let current = self.tables.manifest_json();
            self.tables.set_manifest_json(&json).map_err(bad)?;
            step.tables = Some(current);
        }
        if undo {
            self.redo.push(step);
        } else {
            self.undo.push(step);
        }
        Ok(true)
    }

    pub fn tables(&self) -> &TableStore {
        &self.tables
    }

    pub fn sheets(&self) -> Vec<SheetInfo> {
        self.um
            .get_worksheets_properties()
            .into_iter()
            .enumerate()
            .map(|(i, p)| SheetInfo {
                id: i as u32,
                color: rgb(&self.um, &p.color),
                hidden: p.state != "visible",
                name: p.name,
            })
            .collect()
    }

    pub fn execute(
        &mut self,
        action: &Action,
        clip: &mut Option<SessionClipboard>,
    ) -> Result<Outcome> {
        if !action.is_mutation() {
            return self.query(action, clip).map(Outcome::Query);
        }
        let before = self.tables.manifest_json();
        self.engine_steps = None;
        self.mirror_before(action);
        let reply = match action {
            Action::Undo | Action::Redo => {
                self.step(matches!(action, Action::Undo)).map(|_| Reply::Ok)
            }
            _ => self.mutate(action, clip),
        };
        if self.sync_mirror() {
            self.um.evaluate();
            self.cells_version += 1;
        }
        let diffs = self.um.flush_send_queue();
        let after = self.tables.manifest_json();
        let tables_changed = after != before;
        let engine_changed = diffs != self.empty_queue;
        if engine_changed {
            self.cells_version += 1;
        }
        // An error after part of the cells changed still has to be logged, or replay
        // would diverge from the live model; otherwise nothing happened.
        let reply = match reply {
            Ok(r) => r,
            Err(e) if !engine_changed && !tables_changed => return Err(e),
            Err(_) => Reply::Ok,
        };
        if !engine_changed && !tables_changed {
            return Ok(Outcome::Unchanged(reply));
        }
        if !matches!(action, Action::Undo | Action::Redo) {
            self.undo.push(Step {
                engine: if engine_changed {
                    self.engine_steps.unwrap_or(1)
                } else {
                    0
                },
                tables: tables_changed.then_some(before),
            });
            self.redo.clear();
        }
        self.seq += 1;
        Ok(Outcome::Mutated {
            reply,
            seq: self.seq,
            diffs: if engine_changed { diffs } else { Vec::new() },
            tables: tables_changed.then_some(after),
        })
    }

    fn mutate(&mut self, action: &Action, clip: &mut Option<SessionClipboard>) -> Result<Reply> {
        if let Some(reply) = self.mutate_data(action)? {
            return Ok(reply);
        }
        if let Some(reply) = self.mutate_objects(action)? {
            return Ok(reply);
        }
        self.guard_tables(action)?;
        self.mutate_cells(action, clip)?;
        self.shift_objects(action)?;
        Ok(Reply::Ok)
    }

    fn mutate_cells(&mut self, action: &Action, clip: &mut Option<SessionClipboard>) -> Result<()> {
        let um = &mut self.um;
        match action {
            Action::UpdateCell {
                sheet,
                row,
                col,
                raw,
            } => {
                let (r, c) = cell(*row, *col)?;
                let (raw, new_names) = structured::rewrite(raw, self.tables.manifest());
                for name in &new_names {
                    let exists = um
                        .get_defined_name_list()
                        .iter()
                        .any(|n| n.0.eq_ignore_ascii_case(name));
                    if !exists {
                        // A placeholder range; `sync_structured` sets the real one.
                        um.new_defined_name(name, None, &structured::placeholder(um))
                            .map_err(bad)?;
                        self.engine_steps = Some(self.engine_steps.unwrap_or(1) + 1);
                    }
                }
                um.set_user_input(*sheet, r, c, &raw).map_err(bad)
            }
            Action::PasteText {
                sheet,
                row,
                col,
                text,
            } => {
                let (r, c) = cell(*row, *col)?;
                // Excel's clipboard ends with a newline; a trailing empty record would clear a row.
                let text = text.trim_end_matches(['\r', '\n']);
                // IronCalc re-selects the pasted area afterwards, which requires the
                // view's selected cell to start inside it.
                um.set_selected_sheet(*sheet).map_err(bad)?;
                um.set_selected_cell(r, c).map_err(bad)?;
                um.paste_csv_string(
                    &Area {
                        sheet: *sheet,
                        row: r,
                        column: c,
                        width: 1,
                        height: 1,
                    },
                    text,
                )
                .map_err(bad)
            }
            Action::PasteInternal { sheet, row, col } => {
                let Some(source) = clip.as_mut() else {
                    return Err(bad("nothing to paste".into()));
                };
                let (r, c) = cell(*row, *col)?;
                um.set_selected_sheet(*sheet).map_err(bad)?;
                um.set_selected_cell(r, c).map_err(bad)?;
                let data =
                    serde_json::from_value(source.data.clone()).map_err(|e| bad(e.to_string()))?;
                um.paste_from_clipboard(
                    source.source_sheet,
                    source.source_range,
                    &data,
                    source.cut,
                )
                .map_err(bad)?;
                // A cut moves the cells once; later pastes copy what is now there.
                if source.cut {
                    *clip = None;
                }
                Ok(())
            }
            Action::ClearRange { range, formats } => {
                let a = area(range)?;
                if *formats {
                    um.range_clear_all(&a)
                } else {
                    um.range_clear_contents(&a)
                }
                .map_err(bad)
            }
            Action::Fill {
                source,
                to_row,
                to_col,
            } => {
                let a = area(source)?;
                match (to_row, to_col) {
                    (Some(r), None) => um.auto_fill_rows(&a, cell(*r, 0)?.0).map_err(bad),
                    (None, Some(c)) => um.auto_fill_columns(&a, cell(0, *c)?.1).map_err(bad),
                    _ => Err(bad("fill needs exactly one of to_row or to_col".into())),
                }
            }
            Action::InsertRows { sheet, row, count } => um
                .insert_rows(*sheet, cell(*row, 0)?.0, *count as i32)
                .map_err(bad),
            Action::DeleteRows { sheet, row, count } => um
                .delete_rows(*sheet, cell(*row, 0)?.0, *count as i32)
                .map_err(bad),
            Action::InsertCols { sheet, col, count } => um
                .insert_columns(*sheet, cell(0, *col)?.1, *count as i32)
                .map_err(bad),
            Action::DeleteCols { sheet, col, count } => um
                .delete_columns(*sheet, cell(0, *col)?.1, *count as i32)
                .map_err(bad),
            Action::SetStyle { range, path, value } => um
                .update_range_style(&area(range)?, path, value)
                .map_err(bad),
            Action::SetBorder {
                range,
                kind,
                style,
                color,
            } => {
                let kind = match kind {
                    BorderKind::All => "All",
                    BorderKind::Inner => "Inner",
                    BorderKind::Outer => "Outer",
                    BorderKind::Top => "Top",
                    BorderKind::Right => "Right",
                    BorderKind::Bottom => "Bottom",
                    BorderKind::Left => "Left",
                    BorderKind::None => "None",
                };
                // BorderArea's fields are crate-private; it is built through its serde form.
                let border: BorderArea = serde_json::from_value(serde_json::json!({
                    "item": BorderItem { style: serde_json::from_value(serde_json::json!(style)).map_err(|e| bad(format!("border style: {e}")))?, color: Color::Rgb(color.clone()) },
                    "type": kind,
                }))
                .map_err(|e| bad(e.to_string()))?;
                um.set_area_with_border(&area(range)?, &border).map_err(bad)
            }
            Action::Merge { range } => um.merge_cells(&area(range)?).map_err(bad),
            Action::Unmerge { range } => um.unmerge_cells(&area(range)?).map_err(bad),
            Action::SetColWidth {
                sheet,
                c0,
                c1,
                width,
            } => um
                .set_columns_width(*sheet, cell(0, *c0)?.1, cell(0, *c1)?.1, *width)
                .map_err(bad),
            Action::SetRowHeight {
                sheet,
                r0,
                r1,
                height,
            } => um
                .set_rows_height(*sheet, cell(*r0, 0)?.0, cell(*r1, 0)?.0, *height)
                .map_err(bad),
            Action::Freeze { sheet, rows, cols } => {
                um.set_frozen_rows_count(*sheet, *rows as i32)
                    .map_err(bad)?;
                um.set_frozen_columns_count(*sheet, *cols as i32)
                    .map_err(bad)?;
                self.engine_steps = Some(2);
                Ok(())
            }
            Action::SetGridlines { sheet, show } => {
                um.set_show_grid_lines(*sheet, *show).map_err(bad)
            }
            Action::ReplaceAll {
                sheet,
                find,
                replace,
            } => {
                if find.is_empty() {
                    return Err(bad("nothing to find".into()));
                }
                let needle = find.to_lowercase();
                let cells: Vec<(i32, i32)> = um
                    .get_model()
                    .workbook
                    .worksheet(*sheet)
                    .map_err(bad)?
                    .sheet_data
                    .cells()
                    .map(|(r, c, _)| (r, c))
                    .collect();
                um.pause_evaluation();
                let mut result = Ok(());
                let mut steps = 0;
                for (r, c) in cells {
                    let content = um.get_cell_content(*sheet, r, c).unwrap_or_default();
                    if content.to_lowercase().contains(&needle) {
                        let replaced = replace_case_insensitive(&content, find, replace);
                        if let Err(e) = um.set_user_input(*sheet, r, c, &replaced) {
                            result = Err(bad(e));
                            break;
                        }
                        steps += 1;
                    }
                }
                um.resume_evaluation();
                um.evaluate();
                // Each replaced cell is its own IronCalc undo entry; one user step undoes all.
                self.engine_steps = Some(steps);
                result
            }
            Action::AddSheet => um.new_sheet().map_err(bad),
            Action::RenameSheet { sheet, name } => um.rename_sheet(*sheet, name).map_err(bad),
            Action::DeleteSheet { sheet } => um.delete_sheet(*sheet).map_err(bad),
            Action::MoveSheet { sheet, to } => um.move_sheet(*sheet, *to).map_err(bad),
            Action::DuplicateSheet { sheet } => um.duplicate_sheet(*sheet).map_err(bad),
            Action::SetSheetColor { sheet, color } => um
                .set_sheet_color(*sheet, &Color::Rgb(color.clone()))
                .map_err(bad),
            Action::SetSheetHidden { sheet, hidden } => if *hidden {
                um.hide_sheet(*sheet)
            } else {
                um.unhide_sheet(*sheet)
            }
            .map_err(bad),
            Action::CreateName {
                name,
                scope,
                formula,
            } => um.new_defined_name(name, *scope, formula).map_err(bad),
            Action::UpdateName {
                name,
                scope,
                new_name,
                new_scope,
                formula,
            } => um
                .update_defined_name(name, *scope, new_name, *new_scope, formula)
                .map_err(bad),
            Action::DeleteName { name, scope } => um.delete_defined_name(name, *scope).map_err(bad),
            _ => unreachable!("queries are handled by `query`; data actions by `mutate_data`"),
        }
    }

    fn query(&mut self, action: &Action, clip: &mut Option<SessionClipboard>) -> Result<Reply> {
        if let Some(reply) = self.query_data(action)? {
            return Ok(reply);
        }
        if let Some(reply) = self.query_objects(action)? {
            return Ok(reply);
        }
        match action {
            Action::Hello | Action::Ping => Ok(Reply::Pong),
            Action::GetTiles { sheet, tiles } => {
                let tiles = tiles
                    .iter()
                    .map(|[tr, tc]| self.tile(*sheet, *tr, *tc))
                    .collect::<Result<_>>()?;
                Ok(Reply::Tiles {
                    sheet: *sheet,
                    tiles,
                })
            }
            Action::GetCell { sheet, row, col } => {
                let in_pivot = self.pivot_at(*sheet, *row as u64, *col).is_some();
                if let Some(raw) = self
                    .tables
                    .cell_text(*sheet, *row as u64, *col)
                    .or_else(|| in_pivot.then(|| self.value_at(*sheet, *row as u64, *col).0))
                {
                    return Ok(Reply::Cell {
                        sheet: *sheet,
                        row: *row,
                        col: *col,
                        raw,
                    });
                }
                let (r, c) = cell(*row, *col)?;
                let raw = self.um.get_cell_content(*sheet, r, c).map_err(bad)?;
                let raw = structured::display(&raw, self.tables.manifest());
                Ok(Reply::Cell {
                    sheet: *sheet,
                    row: *row,
                    col: *col,
                    raw,
                })
            }
            Action::GetSheetMeta { sheet } => Ok(Reply::SheetMeta {
                meta: self.sheet_meta(*sheet)?,
            }),
            Action::CopyRange { range, cut } => {
                if self.tables.regions(range.sheet).iter().any(|t| {
                    t.row as u64 <= range.r1 as u64
                        && range.r0 as u64 <= t.row as u64 + t.rows
                        && t.col <= range.c1
                        && range.c0 < t.col + t.visible.len() as u32
                }) {
                    // Table cells copy as text only.
                    *clip = None;
                    return Ok(Reply::Text {
                        text: self.range_text(range)?,
                    });
                }
                let a = area(range)?;
                self.um.set_selected_sheet(range.sheet).map_err(bad)?;
                self.um.set_selected_cell(a.row, a.column).map_err(bad)?;
                self.um
                    .set_selected_range(
                        a.row,
                        a.column,
                        a.row + a.height - 1,
                        a.column + a.width - 1,
                    )
                    .map_err(bad)?;
                let copied = serde_json::to_value(self.um.copy_to_clipboard().map_err(bad)?)
                    .map_err(|e| bad(e.to_string()))?;
                let text = copied["csv"].as_str().unwrap_or_default().to_string();
                *clip = Some(SessionClipboard {
                    source_sheet: range.sheet,
                    source_range: (
                        a.row,
                        a.column,
                        a.row + a.height - 1,
                        a.column + a.width - 1,
                    ),
                    data: copied["data"].clone(),
                    cut: *cut,
                });
                Ok(Reply::Text { text })
            }
            Action::CtrlJump {
                sheet,
                row,
                col,
                dir,
            } => {
                if let Some(t) = self.tables.table_at(*sheet, *row as u64, *col) {
                    let (top, bottom) = (t.row as u64, t.row as u64 + t.rows);
                    let (left, right) = (t.col, t.col + t.visible.len() as u32 - 1);
                    let (r, c) = match dir {
                        Direction::Up => (top, *col),
                        Direction::Down => (bottom, *col),
                        Direction::Left => (*row as u64, left),
                        Direction::Right => (*row as u64, right),
                    };
                    return Ok(Reply::Position {
                        sheet: *sheet,
                        row: r as u32,
                        col: c,
                    });
                }
                let (r, c) = cell(*row, *col)?;
                let dir = match dir {
                    Direction::Up => NavigationDirection::Up,
                    Direction::Down => NavigationDirection::Down,
                    Direction::Left => NavigationDirection::Left,
                    Direction::Right => NavigationDirection::Right,
                };
                let ws = self
                    .um
                    .get_model()
                    .workbook
                    .worksheet(*sheet)
                    .map_err(bad)?;
                let (nr, nc) = ws.navigate_to_edge_in_direction(r, c, dir).map_err(bad)?;
                Ok(Reply::Position {
                    sheet: *sheet,
                    row: nr as u32 - 1,
                    col: nc as u32 - 1,
                })
            }
            Action::Find {
                sheet,
                row,
                col,
                text,
            } => Ok(self
                .find(*sheet, *row, *col, text)?
                .map_or(Reply::NotFound, |(r, c)| Reply::Position {
                    sheet: *sheet,
                    row: r,
                    col: c,
                })),
            Action::SelectionStats { range } => {
                if range.r0 > range.r1 || range.c0 > range.c1 {
                    return Err(bad("range is inverted".into()));
                }
                let t = self.tables.stats(
                    range.sheet,
                    range.r0 as u64,
                    range.r1 as u64,
                    range.c0,
                    range.c1.min(MAX_COLS - 1),
                );
                let ws = self
                    .um
                    .get_model()
                    .workbook
                    .worksheet(range.sheet)
                    .map_err(bad)?;
                let (mut count, mut numbers, mut sum) = (t.count, t.numbers, t.sum);
                let (mut min, mut max) = (t.min, t.max);
                let model = self.um.get_model();
                for r in ws.sheet_data.rows() {
                    if r < range.r0 as i32 + 1 || r > range.r1 as i32 + 1 {
                        continue;
                    }
                    for (c, _) in ws.sheet_data.cells_in_row_between(
                        r,
                        range.c0 as i32 + 1,
                        range.c1.min(MAX_COLS - 1) as i32 + 1,
                    ) {
                        if self.mirror.contains(range.sheet, r, c)
                            || self
                                .tables
                                .table_at(range.sheet, r as u64 - 1, c as u32 - 1)
                                .is_some()
                        {
                            continue;
                        }
                        match model.get_cell_value_by_index(range.sheet, r, c) {
                            Ok(CellValue::Number(n)) => {
                                count += 1;
                                numbers += 1;
                                sum += n;
                                min = Some(min.map_or(n, |m: f64| m.min(n)));
                                max = Some(max.map_or(n, |m: f64| m.max(n)));
                            }
                            Ok(CellValue::None) | Err(_) => {}
                            Ok(_) => count += 1,
                        }
                    }
                }
                Ok(Reply::Stats {
                    count,
                    numbers,
                    sum,
                    min,
                    max,
                })
            }
            Action::ListNames => Ok(Reply::Names {
                names: self
                    .um
                    .get_defined_name_list()
                    .into_iter()
                    .filter(|(name, _, _)| !structured::is_hidden(name))
                    .map(|(name, scope, formula)| NameInfo {
                        name,
                        scope,
                        formula,
                    })
                    .collect(),
            }),
            _ => unreachable!("mutations are handled by `mutate`"),
        }
    }

    fn find(&self, sheet: u32, row: u32, col: u32, text: &str) -> Result<Option<(u32, u32)>> {
        if text.is_empty() {
            return Ok(None);
        }
        let needle = text.to_lowercase();
        let model = self.um.get_model();
        let ws = model.workbook.worksheet(sheet).map_err(bad)?;
        let mut cells: Vec<(i32, i32)> = ws
            .sheet_data
            .cells()
            .map(|(r, c, _)| (r, c))
            .filter(|&(r, c)| !self.mirror.contains(sheet, r, c))
            .collect();
        cells.sort_unstable();
        let start = (row as i32 + 1, col as i32 + 1);
        let matches = |&(r, c): &(i32, i32)| {
            model
                .get_formatted_cell_value(sheet, r, c)
                .map(|v| v.to_lowercase().contains(&needle))
                .unwrap_or(false)
        };
        // Row-major after the start cell, then wrap around.
        let hit = cells
            .iter()
            .filter(|p| **p > start)
            .find(|p| matches(p))
            .or_else(|| cells.iter().filter(|p| **p <= start).find(|p| matches(p)));
        Ok(hit.map(|&(r, c)| (r as u32 - 1, c as u32 - 1)))
    }

    pub fn sheet_meta(&self, sheet: u32) -> Result<SheetMeta> {
        let model = self.um.get_model();
        let ws = model.workbook.worksheet(sheet).map_err(bad)?;
        let default_col_width = COLUMN_WIDTH_FACTOR * 10.0;
        let default_row_height = ROW_HEIGHT_FACTOR * 16.0;
        let mut col_widths = Vec::new();
        'cols: for col in &ws.cols {
            for c in col.min..=col.max {
                if col_widths.len() >= MAX_SIZE_OVERRIDES {
                    break 'cols;
                }
                let w = if col.hidden {
                    0.0
                } else {
                    model
                        .get_column_width(sheet, c)
                        .unwrap_or(default_col_width)
                };
                if (w - default_col_width).abs() > 0.01 {
                    col_widths.push((c as u32 - 1, w));
                }
            }
        }
        let row_heights = ws
            .rows
            .iter()
            .filter(|r| r.custom_height || r.hidden)
            .take(MAX_SIZE_OVERRIDES)
            .map(|r| {
                (
                    r.r as u32 - 1,
                    if r.hidden {
                        0.0
                    } else {
                        model
                            .get_row_height(sheet, r.r)
                            .unwrap_or(default_row_height)
                    },
                )
            })
            .collect();
        let merges = ws
            .merged_cells
            .iter()
            .map(|m| Range {
                sheet,
                r0: m.row as u32 - 1,
                c0: m.column as u32 - 1,
                r1: (m.row + m.height - 1) as u32 - 1,
                c1: (m.column + m.width - 1) as u32 - 1,
            })
            .collect();
        let m = self.tables.manifest();
        Ok(SheetMeta {
            sheet,
            frozen_rows: ws.frozen_rows.max(0) as u32,
            frozen_cols: ws.frozen_columns.max(0) as u32,
            default_col_width,
            default_row_height,
            col_widths,
            row_heights,
            merges,
            show_grid: ws.show_grid_lines,
            row_count: (MAX_ROWS as u64).max(self.tables.row_extent(sheet)).max(
                self.pivot_infos(sheet)
                    .iter()
                    .map(|p| p.spec.row as u64 + p.rows)
                    .max()
                    .unwrap_or(0),
            ),
            pivots: self.pivot_infos(sheet),
            charts: m
                .charts
                .iter()
                .filter(|c| c.sheet == sheet)
                .cloned()
                .collect(),
            slicers: self.slicer_infos(sheet),
            validations: m
                .validations
                .iter()
                .filter(|v| v.range.sheet == sheet)
                .cloned()
                .collect(),
            comments: m
                .comments
                .iter()
                .filter(|c| c.sheet == sheet)
                .cloned()
                .collect(),
            tables: self.tables.info(sheet),
            filters: self
                .tables
                .manifest()
                .range_filters
                .iter()
                .filter(|f| f.range.sheet == sheet)
                .cloned()
                .collect(),
        })
    }

    pub fn tile(&self, sheet: u32, tr: u32, tc: u32) -> Result<Tile> {
        let model = self.um.get_model();
        let ws = model.workbook.worksheet(sheet).map_err(bad)?;
        let mut cells = Vec::new();
        let mut styles: Vec<CellStyle> = vec![CellStyle::default()];
        let mut style_index: HashMap<CellStyle, u16> = HashMap::from([(CellStyle::default(), 0)]);
        let first_col = (tc * TILE_COLS) as i32 + 1;
        let last_col = ((tc + 1) * TILE_COLS).min(MAX_COLS) as i32;
        let tables = self.tables.regions(sheet);
        let pivots = self.pivot_regions(sheet);
        let in_table = |row: u32, c: i32| {
            tables.iter().any(|t| t.contains(row as u64, c as u32 - 1))
                || pivots.iter().any(|p| p.contains(row as u64, c as u32 - 1))
        };
        for dr in 0..TILE_ROWS {
            let row = tr * TILE_ROWS + dr;
            if row >= MAX_ROWS {
                break;
            }
            let r = row as i32 + 1;
            for (c, _) in ws.sheet_data.cells_in_row_between(r, first_col, last_col) {
                if (!tables.is_empty() || !pivots.is_empty()) && in_table(row, c) {
                    continue;
                }
                let display = model
                    .get_formatted_cell_value(sheet, r, c)
                    .unwrap_or_default();
                // Extended style: base style with conditional formats applied.
                let style = self
                    .um
                    .get_extended_cell_style(sheet, r, c)
                    .map(|x| {
                        let mut st = self.cell_style(&x.style);
                        st.bar = x.data_bar.map(|b| {
                            (
                                (b.value.clamp(0.0, 1.0) * 1000.0) as u16,
                                rgb(&self.um, &b.positive_color)
                                    .unwrap_or_else(|| "#638EC6".into()),
                            )
                        });
                        st.icon = x.icon.map(|i| {
                            (
                                objects::icon_name(&i.icon).to_string(),
                                rgb(&self.um, &i.color).unwrap_or_else(|| "#5F6368".into()),
                            )
                        });
                        st
                    })
                    .unwrap_or_default();
                if display.is_empty() && style == CellStyle::default() {
                    continue;
                }
                let k = match model.get_cell_type(sheet, r, c) {
                    Ok(CellType::ErrorValue) => kind::ERROR,
                    Ok(CellType::Number) => kind::NUMBER,
                    Ok(CellType::LogicalValue) => kind::BOOLEAN,
                    _ => 0,
                };
                let next = styles.len() as u16;
                let si = *style_index.entry(style.clone()).or_insert_with(|| {
                    styles.push(style);
                    next
                });
                let idx = dr * TILE_COLS + (c - first_col) as u32;
                cells.push((idx, display, k, si));
            }
        }
        let mut intern = |style: CellStyle, styles: &mut Vec<CellStyle>| {
            let next = styles.len() as u16;
            *style_index.entry(style.clone()).or_insert_with(|| {
                styles.push(style);
                next
            })
        };
        // Filtered-range headers get a menu button (and a mark when filtered).
        let tile_r0 = tr * TILE_ROWS;
        let tile_c0 = tc * TILE_COLS;
        for rf in self
            .tables
            .manifest()
            .range_filters
            .iter()
            .filter(|f| f.range.sheet == sheet)
        {
            let hr = rf.range.r0;
            if hr < tile_r0 || hr >= tile_r0 + TILE_ROWS {
                continue;
            }
            for c in rf.range.c0.max(tile_c0)..=rf.range.c1.min(tile_c0 + TILE_COLS - 1) {
                let idx = (hr - tile_r0) * TILE_COLS + (c - tile_c0);
                let mut flags = kind::HEADER_BUTTON;
                if rf.filters.iter().any(|(fc, _)| *fc == c) {
                    flags |= kind::FILTERED;
                }
                match cells.iter_mut().find(|x| x.0 == idx) {
                    Some(x) => x.2 |= flags,
                    None => cells.push((idx, String::new(), flags, 0)),
                }
            }
        }
        // Dropdown arrows for data-validation cells (drawn on the focused cell).
        for v in self
            .tables
            .manifest()
            .validations
            .iter()
            .filter(|v| v.range.sheet == sheet)
        {
            let (r0, r1) = (
                v.range.r0.max(tile_r0),
                v.range.r1.min(tile_r0 + TILE_ROWS - 1),
            );
            let (c0, c1) = (
                v.range.c0.max(tile_c0),
                v.range.c1.min(tile_c0 + TILE_COLS - 1),
            );
            if r0 > r1 || c0 > c1 {
                continue;
            }
            for r in r0..=r1 {
                for c in c0..=c1 {
                    let idx = (r - tile_r0) * TILE_COLS + (c - tile_c0);
                    match cells.iter_mut().find(|x| x.0 == idx) {
                        Some(x) => x.2 |= kind::DROPDOWN,
                        None => cells.push((idx, String::new(), kind::DROPDOWN, 0)),
                    }
                }
            }
        }
        // Pivot output.
        for p in &pivots {
            let Ok(grid) = &*p.grid else {
                if p.spec.row >= tile_r0
                    && p.spec.row < tile_r0 + TILE_ROWS
                    && p.spec.col >= tile_c0
                    && p.spec.col < tile_c0 + TILE_COLS
                {
                    let err = CellStyle {
                        color: Some("#C5221F".into()),
                        ..CellStyle::default()
                    };
                    let si = intern(err, &mut styles);
                    let idx = (p.spec.row - tile_r0) * TILE_COLS + (p.spec.col - tile_c0);
                    let msg = p.grid.as_ref().as_ref().err().cloned().unwrap_or_default();
                    cells.push((idx, format!("Pivot error: {msg}"), kind::ERROR, si));
                }
                continue;
            };
            if grid.height() == 0 {
                if p.spec.row >= tile_r0
                    && p.spec.row < tile_r0 + TILE_ROWS
                    && p.spec.col >= tile_c0
                    && p.spec.col < tile_c0 + TILE_COLS
                {
                    let si = intern(
                        CellStyle {
                            color: Some("#5F6368".into()),
                            font: font::ITALIC,
                            ..CellStyle::default()
                        },
                        &mut styles,
                    );
                    let idx = (p.spec.row - tile_r0) * TILE_COLS + (p.spec.col - tile_c0);
                    cells.push((idx, "Pivot table — choose fields".into(), 0, si));
                }
                continue;
            }
            let header = CellStyle {
                font: font::BOLD,
                fill: Some("#F1F3F4".into()),
                bottom: Some(("thin".into(), "#9AA0A6".into())),
                ..CellStyle::default()
            };
            let total = CellStyle {
                font: font::BOLD,
                top: Some(("thin".into(), "#9AA0A6".into())),
                ..CellStyle::default()
            };
            for gr in 0..grid.height() {
                let sr = p.spec.row + gr as u32;
                if sr < tile_r0 || sr >= tile_r0 + TILE_ROWS {
                    continue;
                }
                for gc in 0..grid.width {
                    let sc = p.spec.col + gc as u32;
                    if sc < tile_c0 || sc >= tile_c0 + TILE_COLS {
                        continue;
                    }
                    let style = if gr == 0 {
                        header.clone()
                    } else if Some(gr) == grid.total_row {
                        total.clone()
                    } else {
                        CellStyle::default()
                    };
                    let cell = grid.get(gr, gc);
                    if cell.is_none() && style == CellStyle::default() {
                        continue;
                    }
                    let si = intern(style, &mut styles);
                    let idx = (sr - tile_r0) * TILE_COLS + (sc - tile_c0);
                    let (text, mut k) = cell.map(|c| (c.text.clone(), c.kind)).unwrap_or_default();
                    if let Some(t) = grid.toggles.iter().find(|t| t.0 == gr && t.1 == gc) {
                        k |= kind::HEADER_BUTTON | kind::DROPDOWN;
                        if t.3 {
                            k |= kind::FILTERED;
                        }
                    }
                    cells.push((idx, text, k, si));
                }
            }
        }
        // Data Table cells.
        let r0 = tile_r0 as u64;
        let c1 = (tile_c0 + TILE_COLS - 1).min(MAX_COLS - 1);
        for (row, col, text, k, style) in
            self.tables
                .tile_cells(sheet, r0, r0 + TILE_ROWS as u64 - 1, tile_c0, c1)
        {
            let si = intern(style, &mut styles);
            let idx = (row - r0) as u32 * TILE_COLS + (col - tile_c0);
            cells.push((idx, text, k, si));
        }
        Ok(Tile {
            tr,
            tc,
            cells,
            styles,
        })
    }

    /// Display text of a range as TSV (tables included), for copying.
    fn range_text(&self, range: &Range) -> Result<String> {
        let cells =
            (range.r1 as u64 - range.r0 as u64 + 1) * (range.c1 as u64 - range.c0 as u64 + 1);
        if cells > 1_000_000 {
            return Err(bad("copy at most 1,000,000 cells at a time".into()));
        }
        let mut out = String::new();
        for r in range.r0..=range.r1 {
            if r > range.r0 {
                out.push('\n');
            }
            for c in range.c0..=range.c1 {
                if c > range.c0 {
                    out.push('\t');
                }
                let text = self.value_at(range.sheet, r as u64, c).0;
                out.push_str(&text.replace(['\t', '\n'], " "));
            }
        }
        Ok(out)
    }

    fn cell_style(&self, s: &Style) -> CellStyle {
        let mut f = 0;
        if s.font.b {
            f |= font::BOLD;
        }
        if s.font.i {
            f |= font::ITALIC;
        }
        if s.font.u {
            f |= font::UNDERLINE;
        }
        if s.font.strike {
            f |= font::STRIKE;
        }
        let mut align = None;
        if let Some(a) = &s.alignment {
            if a.wrap_text {
                f |= font::WRAP;
            }
            align = match a.horizontal {
                HorizontalAlignment::Left => Some("left"),
                HorizontalAlignment::Center | HorizontalAlignment::CenterContinuous => {
                    Some("center")
                }
                HorizontalAlignment::Right => Some("right"),
                _ => None,
            }
            .map(str::to_string);
        }
        let edge = |item: &Option<BorderItem>| {
            item.as_ref().map(|b| {
                (
                    b.style.to_string(),
                    rgb(&self.um, &b.color).unwrap_or_else(|| "#000000".into()),
                )
            })
        };
        CellStyle {
            font: f,
            color: rgb(&self.um, &s.font.color),
            fill: rgb(&self.um, &s.fill.color),
            align,
            size: (s.font.sz != 12).then_some(s.font.sz),
            top: edge(&s.border.top),
            right: edge(&s.border.right),
            bottom: edge(&s.border.bottom),
            left: edge(&s.border.left),
            bar: None,
            icon: None,
        }
    }

    /// Evaluated value, for tests and server-side checks.
    pub fn value(&self, sheet: u32, row: u32, col: u32) -> CellValue {
        self.um
            .get_model()
            .get_cell_value_by_index(sheet, row as i32 + 1, col as i32 + 1)
            .unwrap_or(CellValue::None)
    }
}

fn replace_case_insensitive(haystack: &str, find: &str, replace: &str) -> String {
    let lower = haystack.to_lowercase();
    let needle = find.to_lowercase();
    // Lowercasing can change byte lengths for some scripts; fall back to exact-case replace then.
    if lower.len() != haystack.len() {
        return haystack.replace(find, replace);
    }
    let mut out = String::with_capacity(haystack.len());
    let mut last = 0;
    for (i, _) in lower.match_indices(&needle) {
        out.push_str(&haystack[last..i]);
        out.push_str(replace);
        last = i + needle.len();
    }
    out.push_str(&haystack[last..]);
    out
}

#[cfg(test)]
mod tests;
