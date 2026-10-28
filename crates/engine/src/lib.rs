//! Workbook state on top of IronCalc: applies actions and renders tiles.
//! Owned by exactly one actor thread (BUILD-SPEC §3), so it needs no locking.

use ironcalc_base::cell::CellValue;
use ironcalc_base::types::CellType;
use ironcalc_base::Model;
use protocol::{flags, Action, SheetInfo, Tile, TILE_COLS, TILE_ROWS};

/// Engine identity recorded in snapshots (S1 obligation A3): IronCalc's bitcode
/// layout is version-coupled, so a snapshot must say which engine wrote it.
pub const ENGINE_VERSION: &str = "ironcalc_base@0.9.1";

/// Excel's limits; IronCalc rows and columns are 1-based.
pub const MAX_ROWS: u32 = 1_048_576;
pub const MAX_COLS: u32 = 16_384;

pub struct Workbook {
    model: Model<'static>,
    pub seq: u64,
}

#[derive(Debug, PartialEq)]
pub enum EngineError {
    BadInput(String),
    OutOfRange,
    NotAMutation,
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::BadInput(m) => write!(f, "bad input: {m}"),
            EngineError::OutOfRange => write!(f, "cell out of range"),
            EngineError::NotAMutation => write!(f, "action does not change the workbook"),
        }
    }
}

impl Workbook {
    pub fn new_empty() -> Self {
        let model = Model::new_empty("workbook", "en", "UTC", "en").expect("en/UTC are valid");
        Workbook { model, seq: 0 }
    }

    pub fn from_snapshot(bytes: &[u8], seq: u64) -> Result<Self, String> {
        let mut model = Model::from_bytes(bytes, "en")?;
        model.evaluate();
        Ok(Workbook { model, seq })
    }

    pub fn to_snapshot(&self) -> Vec<u8> {
        self.model.to_bytes()
    }

    pub fn sheets(&self) -> Vec<SheetInfo> {
        self.model
            .get_worksheets_properties()
            .into_iter()
            .enumerate()
            .map(|(i, p)| SheetInfo { id: i as u32, name: p.name })
            .collect()
    }

    /// Apply a mutating action and recalculate. Bumps `seq` on success.
    pub fn apply(&mut self, action: &Action) -> Result<u64, EngineError> {
        match action {
            Action::UpdateCell { sheet, row, col, raw } => {
                check_cell(*row, *col)?;
                self.model
                    .set_user_input(*sheet, *row as i32 + 1, *col as i32 + 1, raw.clone())
                    .map_err(EngineError::BadInput)?;
            }
            _ => return Err(EngineError::NotAMutation),
        }
        // Full recalculation: IronCalc has no dirty tracking yet (S1 finding 1 / obligation A1).
        self.model.evaluate();
        self.seq += 1;
        Ok(self.seq)
    }

    /// Replay a logged mutation without re-evaluating; call `evaluate` once after a batch.
    pub fn replay(&mut self, seq: u64, action: &Action) -> Result<(), EngineError> {
        if let Action::UpdateCell { sheet, row, col, raw } = action {
            check_cell(*row, *col)?;
            self.model
                .set_user_input(*sheet, *row as i32 + 1, *col as i32 + 1, raw.clone())
                .map_err(EngineError::BadInput)?;
        }
        self.seq = seq;
        Ok(())
    }

    pub fn evaluate(&mut self) {
        self.model.evaluate();
    }

    pub fn cell_raw(&self, sheet: u32, row: u32, col: u32) -> Result<String, EngineError> {
        check_cell(row, col)?;
        self.model
            .get_localized_cell_content(sheet, row as i32 + 1, col as i32 + 1)
            .map_err(EngineError::BadInput)
    }

    pub fn tile(&self, sheet: u32, tr: u32, tc: u32) -> Tile {
        let mut cells = Vec::new();
        for dr in 0..TILE_ROWS {
            let row = tr * TILE_ROWS + dr;
            if row >= MAX_ROWS {
                break;
            }
            for dc in 0..TILE_COLS {
                let col = tc * TILE_COLS + dc;
                if col >= MAX_COLS {
                    break;
                }
                let (r, c) = (row as i32 + 1, col as i32 + 1);
                let Ok(display) = self.model.get_formatted_cell_value(sheet, r, c) else { continue };
                if display.is_empty() {
                    continue;
                }
                let mut f = 0u8;
                match self.model.get_cell_type(sheet, r, c) {
                    Ok(CellType::ErrorValue) => f |= flags::ERROR,
                    Ok(CellType::Number) => f |= flags::NUMBER,
                    _ => {}
                }
                if let Ok(style) = self.model.get_style_for_cell(sheet, r, c) {
                    if style.font.b {
                        f |= flags::BOLD;
                    }
                }
                cells.push((dr * TILE_COLS + dc, display, f));
            }
        }
        Tile { tr, tc, cells }
    }

    /// Evaluated value, for tests and server-side checks.
    pub fn value(&self, sheet: u32, row: u32, col: u32) -> CellValue {
        self.model
            .get_cell_value_by_index(sheet, row as i32 + 1, col as i32 + 1)
            .unwrap_or(CellValue::None)
    }
}

fn check_cell(row: u32, col: u32) -> Result<(), EngineError> {
    if row < MAX_ROWS && col < MAX_COLS {
        Ok(())
    } else {
        Err(EngineError::OutOfRange)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(wb: &mut Workbook, row: u32, col: u32, raw: &str) -> u64 {
        wb.apply(&Action::UpdateCell { sheet: 0, row, col, raw: raw.into() }).unwrap()
    }

    #[test]
    fn edits_recalculate_and_bump_seq() {
        let mut wb = Workbook::new_empty();
        assert_eq!(set(&mut wb, 0, 0, "2"), 1);
        set(&mut wb, 1, 0, "3");
        set(&mut wb, 2, 0, "=A1*A2");
        assert_eq!(wb.value(0, 2, 0), CellValue::Number(6.0));
        set(&mut wb, 0, 0, "10");
        assert_eq!(wb.value(0, 2, 0), CellValue::Number(30.0));
        assert_eq!(wb.cell_raw(0, 2, 0).unwrap(), "=A1*A2");
        assert_eq!(wb.seq, 4);
    }

    #[test]
    fn tile_reports_display_text_and_flags() {
        let mut wb = Workbook::new_empty();
        set(&mut wb, 0, 0, "hello");
        set(&mut wb, 1, 1, "=1/0");
        set(&mut wb, 70, 2, "1.5");
        let t = wb.tile(0, 0, 0);
        assert!(t.cells.contains(&(0, "hello".into(), 0)));
        assert!(t.cells.contains(&(TILE_COLS + 1, "#DIV/0!".into(), flags::ERROR)));
        let t = wb.tile(0, 1, 0);
        assert!(t.cells.contains(&((70 - TILE_ROWS) * TILE_COLS + 2, "1.5".into(), flags::NUMBER)));
    }

    #[test]
    fn snapshot_round_trip_and_replay() {
        let mut wb = Workbook::new_empty();
        set(&mut wb, 0, 0, "5");
        set(&mut wb, 0, 1, "=A1+1");
        let mut restored = Workbook::from_snapshot(&wb.to_snapshot(), wb.seq).unwrap();
        assert_eq!(restored.value(0, 0, 1), CellValue::Number(6.0));
        restored.replay(3, &Action::UpdateCell { sheet: 0, row: 0, col: 0, raw: "7".into() }).unwrap();
        restored.evaluate();
        assert_eq!(restored.value(0, 0, 1), CellValue::Number(8.0));
        assert_eq!(restored.seq, 3);
    }

    #[test]
    fn rejects_out_of_range_and_non_mutations() {
        let mut wb = Workbook::new_empty();
        assert_eq!(wb.apply(&Action::UpdateCell { sheet: 0, row: MAX_ROWS, col: 0, raw: "1".into() }), Err(EngineError::OutOfRange));
        assert_eq!(wb.apply(&Action::Ping), Err(EngineError::NotAMutation));
        assert_eq!(wb.seq, 0);
    }
}
