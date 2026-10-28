//! Workbook state on top of IronCalc's `UserModel` (undo/redo, ranges, styles,
//! sheets, names). Owned by exactly one actor thread (BUILD-SPEC §3), so it needs
//! no locking.
//!
//! Every mutation is captured as IronCalc's own diff list (`flush_send_queue`).
//! The op-log stores those diffs rather than actions, so replay is exact even for
//! undo/redo, whose history is not part of a snapshot.

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
    /// The workbook changed: `diffs` is what the op-log persists.
    Mutated {
        reply: Reply,
        seq: u64,
        diffs: Vec<u8>,
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
    fn wrap(mut um: UserModel<'static>, seq: u64) -> Self {
        um.flush_send_queue();
        let empty_queue = um.flush_send_queue();
        Workbook {
            um,
            seq,
            empty_queue,
        }
    }

    pub fn new_empty() -> Self {
        Self::wrap(
            UserModel::new_empty("workbook", "en", "UTC", "en").expect("en/UTC are valid"),
            0,
        )
    }

    pub fn from_snapshot(bytes: &[u8], seq: u64) -> std::result::Result<Self, String> {
        let mut um = UserModel::from_bytes(bytes, "en")?;
        um.evaluate();
        Ok(Self::wrap(um, seq))
    }

    pub fn to_snapshot(&self) -> Vec<u8> {
        self.um.to_bytes()
    }

    /// Apply logged diffs during rehydrate. Call `evaluate` once after a batch.
    pub fn replay(&mut self, seq: u64, diffs: &[u8]) -> std::result::Result<(), String> {
        self.um.pause_evaluation();
        let result = self.um.apply_external_diffs(diffs);
        self.um.resume_evaluation();
        self.seq = seq;
        self.um.flush_send_queue();
        result
    }

    pub fn evaluate(&mut self) {
        self.um.evaluate();
    }

    pub fn can_undo(&self) -> bool {
        self.um.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.um.can_redo()
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
        let reply = self.mutate(action, clip);
        let diffs = self.um.flush_send_queue();
        reply?;
        if diffs == self.empty_queue {
            return Ok(Outcome::Unchanged(Reply::Ok));
        }
        self.seq += 1;
        Ok(Outcome::Mutated {
            reply: Reply::Ok,
            seq: self.seq,
            diffs,
        })
    }

    fn mutate(&mut self, action: &Action, clip: &mut Option<SessionClipboard>) -> Result<()> {
        let um = &mut self.um;
        match action {
            Action::UpdateCell {
                sheet,
                row,
                col,
                raw,
            } => {
                let (r, c) = cell(*row, *col)?;
                um.set_user_input(*sheet, r, c, raw).map_err(bad)
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
            Action::Undo => um.undo().map_err(bad),
            Action::Redo => um.redo().map_err(bad),
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
                    .map_err(bad)
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
                for (r, c) in cells {
                    let content = um.get_cell_content(*sheet, r, c).unwrap_or_default();
                    if content.to_lowercase().contains(&needle) {
                        let replaced = replace_case_insensitive(&content, find, replace);
                        if let Err(e) = um.set_user_input(*sheet, r, c, &replaced) {
                            result = Err(bad(e));
                            break;
                        }
                    }
                }
                um.resume_evaluation();
                um.evaluate();
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
            _ => unreachable!("queries are handled by `query`"),
        }
    }

    fn query(&mut self, action: &Action, clip: &mut Option<SessionClipboard>) -> Result<Reply> {
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
                let (r, c) = cell(*row, *col)?;
                let raw = self.um.get_cell_content(*sheet, r, c).map_err(bad)?;
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
                area(range)?;
                let ws = self
                    .um
                    .get_model()
                    .workbook
                    .worksheet(range.sheet)
                    .map_err(bad)?;
                let (mut count, mut numbers, mut sum) = (0u64, 0u64, 0f64);
                let model = self.um.get_model();
                for r in ws.sheet_data.rows() {
                    if r < range.r0 as i32 + 1 || r > range.r1 as i32 + 1 {
                        continue;
                    }
                    for (c, _) in ws.sheet_data.cells_in_row_between(
                        r,
                        range.c0 as i32 + 1,
                        range.c1 as i32 + 1,
                    ) {
                        match model.get_cell_value_by_index(range.sheet, r, c) {
                            Ok(CellValue::Number(n)) => {
                                count += 1;
                                numbers += 1;
                                sum += n;
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
                })
            }
            Action::ListNames => Ok(Reply::Names {
                names: self
                    .um
                    .get_defined_name_list()
                    .into_iter()
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
        let mut cells: Vec<(i32, i32)> = ws.sheet_data.cells().map(|(r, c, _)| (r, c)).collect();
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
        for dr in 0..TILE_ROWS {
            let row = tr * TILE_ROWS + dr;
            if row >= MAX_ROWS {
                break;
            }
            let r = row as i32 + 1;
            for (c, _) in ws.sheet_data.cells_in_row_between(r, first_col, last_col) {
                let display = model
                    .get_formatted_cell_value(sheet, r, c)
                    .unwrap_or_default();
                let style = self
                    .um
                    .get_cell_style(sheet, r, c)
                    .map(|s| self.cell_style(&s))
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
        Ok(Tile {
            tr,
            tc,
            cells,
            styles,
        })
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
