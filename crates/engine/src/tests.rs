use super::*;

const S: u32 = 0;

fn run(wb: &mut Workbook, action: Action) -> Outcome {
    let mut clip = None;
    wb.execute(&action, &mut clip)
        .unwrap_or_else(|e| panic!("{action:?} failed: {e}"))
}

fn set(wb: &mut Workbook, row: u32, col: u32, raw: &str) {
    run(
        wb,
        Action::UpdateCell {
            sheet: S,
            row,
            col,
            raw: raw.into(),
        },
    );
}

fn num(wb: &Workbook, row: u32, col: u32) -> f64 {
    match wb.value(S, row, col) {
        CellValue::Number(n) => n,
        other => panic!("({row},{col}) is {other:?}"),
    }
}

fn range(r0: u32, c0: u32, r1: u32, c1: u32) -> Range {
    Range {
        sheet: S,
        r0,
        c0,
        r1,
        c1,
    }
}

fn reply(o: Outcome) -> Reply {
    match o {
        Outcome::Query(r) | Outcome::Unchanged(r) | Outcome::Mutated { reply: r, .. } => r,
    }
}

#[test]
fn edits_recalculate_and_bump_seq() {
    let mut wb = Workbook::new_empty();
    set(&mut wb, 0, 0, "2");
    set(&mut wb, 1, 0, "3");
    set(&mut wb, 2, 0, "=A1*A2");
    assert_eq!(num(&wb, 2, 0), 6.0);
    set(&mut wb, 0, 0, "10");
    assert_eq!(num(&wb, 2, 0), 30.0);
    assert_eq!(wb.seq, 4);
    assert!(
        matches!(reply(run(&mut wb, Action::GetCell { sheet: S, row: 2, col: 0 })), Reply::Cell { raw, .. } if raw == "=A1*A2")
    );
}

#[test]
fn fifty_step_undo_redo() {
    let mut wb = Workbook::new_empty();
    for i in 0..50 {
        set(&mut wb, i, 0, &(i + 1).to_string());
    }
    set(&mut wb, 50, 0, "=SUM(A1:A50)");
    assert_eq!(num(&wb, 50, 0), 1275.0);
    for _ in 0..50 {
        assert!(matches!(
            run(&mut wb, Action::Undo),
            Outcome::Mutated { .. }
        ));
    }
    // 50 undos remove the SUM and A50..A2; A1 is still 1.
    assert_eq!(wb.value(S, 50, 0), CellValue::None);
    assert_eq!(num(&wb, 0, 0), 1.0);
    assert_eq!(wb.value(S, 1, 0), CellValue::None);
    for _ in 0..50 {
        run(&mut wb, Action::Redo);
    }
    assert_eq!(num(&wb, 50, 0), 1275.0);
    assert!(!wb.can_redo());
    // Undo past history is a no-op, not an error.
    let mut wb = Workbook::new_empty();
    assert!(matches!(run(&mut wb, Action::Undo), Outcome::Unchanged(_)));
}

#[test]
fn paste_ten_thousand_cells_from_excel_tsv() {
    let mut wb = Workbook::new_empty();
    // 1000 rows x 10 columns, Excel-style CRLF with a trailing newline.
    let mut tsv = String::new();
    for r in 0..1000 {
        let row: Vec<String> = (0..10)
            .map(|c| {
                if c == 9 {
                    format!("item {r}")
                } else {
                    (r * 10 + c).to_string()
                }
            })
            .collect();
        tsv.push_str(&row.join("\t"));
        tsv.push_str("\r\n");
    }
    run(
        &mut wb,
        Action::PasteText {
            sheet: S,
            row: 2,
            col: 1,
            text: tsv,
        },
    );
    assert_eq!(num(&wb, 2, 1), 0.0);
    assert_eq!(num(&wb, 1001, 9), 9998.0);
    assert_eq!(wb.value(S, 1001, 10), CellValue::String("item 999".into()));
    assert_eq!(
        wb.value(S, 1002, 1),
        CellValue::None,
        "no extra row from the trailing newline"
    );
    match reply(run(
        &mut wb,
        Action::SelectionStats {
            range: range(2, 1, 1001, 10),
        },
    )) {
        Reply::Stats { count, numbers, .. } => assert_eq!((count, numbers), (10_000, 9_000)),
        other => panic!("{other:?}"),
    }
}

#[test]
fn copy_paste_keeps_relative_formulas_and_cut_moves() {
    let mut wb = Workbook::new_empty();
    let mut clip = None;
    set(&mut wb, 0, 0, "1");
    set(&mut wb, 0, 1, "=A1*10");
    let text = wb
        .execute(
            &Action::CopyRange {
                range: range(0, 0, 0, 1),
                cut: false,
            },
            &mut clip,
        )
        .unwrap();
    assert!(matches!(reply(text), Reply::Text { text } if text.contains('1')));
    wb.execute(
        &Action::PasteInternal {
            sheet: S,
            row: 4,
            col: 0,
        },
        &mut clip,
    )
    .unwrap();
    assert_eq!(num(&wb, 4, 1), 10.0);
    assert!(
        matches!(reply(run(&mut wb, Action::GetCell { sheet: S, row: 4, col: 1 })), Reply::Cell { raw, .. } if raw == "=A5*10")
    );

    wb.execute(
        &Action::CopyRange {
            range: range(4, 0, 4, 1),
            cut: true,
        },
        &mut clip,
    )
    .unwrap();
    wb.execute(
        &Action::PasteInternal {
            sheet: S,
            row: 8,
            col: 0,
        },
        &mut clip,
    )
    .unwrap();
    assert_eq!(wb.value(S, 4, 0), CellValue::None, "cut source is cleared");
    assert_eq!(num(&wb, 8, 1), 10.0);
    assert!(clip.is_none(), "a cut pastes once");
}

#[test]
fn fill_insert_delete_and_clear() {
    let mut wb = Workbook::new_empty();
    set(&mut wb, 0, 0, "1");
    set(&mut wb, 1, 0, "2");
    run(
        &mut wb,
        Action::Fill {
            source: range(0, 0, 1, 0),
            to_row: Some(9),
            to_col: None,
        },
    );
    assert_eq!(num(&wb, 9, 0), 10.0, "series continues");
    set(&mut wb, 0, 2, "=SUM(A1:A10)");
    assert_eq!(num(&wb, 0, 2), 55.0);

    run(
        &mut wb,
        Action::InsertRows {
            sheet: S,
            row: 0,
            count: 2,
        },
    );
    assert_eq!(num(&wb, 2, 0), 1.0);
    assert_eq!(
        num(&wb, 2, 2),
        55.0,
        "formula moved and still sums the shifted range"
    );
    run(
        &mut wb,
        Action::DeleteRows {
            sheet: S,
            row: 0,
            count: 2,
        },
    );
    run(
        &mut wb,
        Action::InsertCols {
            sheet: S,
            col: 0,
            count: 1,
        },
    );
    assert_eq!(num(&wb, 0, 1), 1.0);
    run(
        &mut wb,
        Action::DeleteCols {
            sheet: S,
            col: 0,
            count: 1,
        },
    );
    assert_eq!(num(&wb, 0, 2), 55.0);

    run(
        &mut wb,
        Action::ClearRange {
            range: range(0, 0, 4, 0),
            formats: false,
        },
    );
    assert_eq!(num(&wb, 0, 2), 40.0);
}

#[test]
fn styles_borders_merges_sizes_and_freeze() {
    let mut wb = Workbook::new_empty();
    set(&mut wb, 0, 0, "1234.5");
    set(&mut wb, 0, 1, "Title");
    run(
        &mut wb,
        Action::SetStyle {
            range: range(0, 0, 0, 0),
            path: "num_fmt".into(),
            value: "#,##0.00".into(),
        },
    );
    run(
        &mut wb,
        Action::SetStyle {
            range: range(0, 1, 0, 1),
            path: "font.b".into(),
            value: "true".into(),
        },
    );
    run(
        &mut wb,
        Action::SetStyle {
            range: range(0, 1, 0, 1),
            path: "fill.color".into(),
            value: "#FFF2CC".into(),
        },
    );
    run(
        &mut wb,
        Action::SetStyle {
            range: range(0, 1, 0, 1),
            path: "alignment.horizontal".into(),
            value: "center".into(),
        },
    );
    run(
        &mut wb,
        Action::SetBorder {
            range: range(2, 0, 3, 1),
            kind: BorderKind::All,
            style: "thin".into(),
            color: "#000000".into(),
        },
    );

    let tile = wb.tile(S, 0, 0).unwrap();
    let find = |idx: u32| tile.cells.iter().find(|c| c.0 == idx).cloned().unwrap();
    let (_, text, k, _) = find(0);
    assert_eq!((text.as_str(), k), ("1,234.50", kind::NUMBER));
    let (_, _, _, si) = find(1);
    let style = &tile.styles[si as usize];
    assert_eq!(style.font & font::BOLD, font::BOLD);
    assert_eq!(style.fill.as_deref(), Some("#FFF2CC"));
    assert_eq!(style.align.as_deref(), Some("center"));
    // A bordered empty cell is still rendered.
    let (_, text, _, si) = find(2 * TILE_COLS);
    assert!(text.is_empty());
    assert_eq!(
        tile.styles[si as usize].top.as_ref().map(|e| e.0.as_str()),
        Some("thin")
    );

    run(
        &mut wb,
        Action::Merge {
            range: range(5, 0, 6, 2),
        },
    );
    run(
        &mut wb,
        Action::SetColWidth {
            sheet: S,
            c0: 1,
            c1: 1,
            width: 200.0,
        },
    );
    run(
        &mut wb,
        Action::SetRowHeight {
            sheet: S,
            r0: 3,
            r1: 3,
            height: 40.0,
        },
    );
    run(
        &mut wb,
        Action::Freeze {
            sheet: S,
            rows: 1,
            cols: 1,
        },
    );
    let meta = wb.sheet_meta(S).unwrap();
    assert_eq!(meta.merges, vec![range(5, 0, 6, 2)]);
    assert_eq!(meta.col_widths, vec![(1, 200.0)]);
    assert_eq!(meta.row_heights, vec![(3, 40.0)]);
    assert_eq!((meta.frozen_rows, meta.frozen_cols), (1, 1));
    run(
        &mut wb,
        Action::Unmerge {
            range: range(5, 0, 6, 2),
        },
    );
    assert!(wb.sheet_meta(S).unwrap().merges.is_empty());
}

#[test]
fn sheets_and_names() {
    let mut wb = Workbook::new_empty();
    run(&mut wb, Action::AddSheet);
    run(
        &mut wb,
        Action::RenameSheet {
            sheet: 1,
            name: "Data".into(),
        },
    );
    run(
        &mut wb,
        Action::UpdateCell {
            sheet: 1,
            row: 0,
            col: 0,
            raw: "42".into(),
        },
    );
    set(&mut wb, 0, 0, "=Data!A1+1");
    assert_eq!(num(&wb, 0, 0), 43.0);
    run(&mut wb, Action::DuplicateSheet { sheet: 1 });
    run(
        &mut wb,
        Action::SetSheetColor {
            sheet: 1,
            color: "#FF0000".into(),
        },
    );
    let sheets = wb.sheets();
    assert_eq!(sheets.len(), 3);
    assert_eq!(sheets[1].name, "Data");
    assert_eq!(sheets[1].color.as_deref(), Some("#FF0000"));
    run(&mut wb, Action::MoveSheet { sheet: 2, to: 0 });
    assert_ne!(wb.sheets()[0].name, "Sheet1");
    run(&mut wb, Action::DeleteSheet { sheet: 0 });
    assert_eq!(wb.sheets().len(), 2);

    run(
        &mut wb,
        Action::CreateName {
            name: "Answer".into(),
            scope: None,
            formula: "Data!$A$1".into(),
        },
    );
    set(&mut wb, 1, 0, "=Answer*2");
    assert_eq!(num(&wb, 1, 0), 84.0);
    assert!(
        matches!(reply(run(&mut wb, Action::ListNames)), Reply::Names { names } if names.len() == 1 && names[0].name == "Answer")
    );
    run(
        &mut wb,
        Action::DeleteName {
            name: "Answer".into(),
            scope: None,
        },
    );
    assert!(
        matches!(reply(run(&mut wb, Action::ListNames)), Reply::Names { names } if names.is_empty())
    );
}

#[test]
fn navigation_find_and_replace() {
    let mut wb = Workbook::new_empty();
    for r in 0..5 {
        set(&mut wb, r, 0, &format!("row {r}"));
    }
    set(&mut wb, 9, 0, "Target");
    let jump = |wb: &mut Workbook, row, dir| {
        reply(run(
            wb,
            Action::CtrlJump {
                sheet: S,
                row,
                col: 0,
                dir,
            },
        ))
    };
    assert_eq!(
        jump(&mut wb, 0, Direction::Down),
        Reply::Position {
            sheet: S,
            row: 4,
            col: 0
        }
    );
    assert_eq!(
        jump(&mut wb, 4, Direction::Down),
        Reply::Position {
            sheet: S,
            row: 9,
            col: 0
        }
    );
    assert_eq!(
        jump(&mut wb, 9, Direction::Down),
        Reply::Position {
            sheet: S,
            row: MAX_ROWS - 1,
            col: 0
        }
    );

    let find = |wb: &mut Workbook, row, text: &str| {
        reply(run(
            wb,
            Action::Find {
                sheet: S,
                row,
                col: 0,
                text: text.into(),
            },
        ))
    };
    assert_eq!(
        find(&mut wb, 0, "target"),
        Reply::Position {
            sheet: S,
            row: 9,
            col: 0
        }
    );
    assert_eq!(
        find(&mut wb, 2, "ROW"),
        Reply::Position {
            sheet: S,
            row: 3,
            col: 0
        }
    );
    assert_eq!(
        find(&mut wb, 4, "row"),
        Reply::Position {
            sheet: S,
            row: 0,
            col: 0
        },
        "wraps around"
    );
    assert_eq!(find(&mut wb, 0, "absent"), Reply::NotFound);

    run(
        &mut wb,
        Action::ReplaceAll {
            sheet: S,
            find: "ROW".into(),
            replace: "line".into(),
        },
    );
    assert_eq!(wb.value(S, 3, 0), CellValue::String("line 3".into()));
}

#[test]
fn viewers_cannot_reach_mutations_through_queries() {
    // Queries never produce diffs.
    let mut wb = Workbook::new_empty();
    set(&mut wb, 0, 0, "1");
    for q in [
        Action::GetTiles {
            sheet: S,
            tiles: vec![[0, 0]],
        },
        Action::GetSheetMeta { sheet: S },
        Action::ListNames,
    ] {
        assert!(matches!(run(&mut wb, q), Outcome::Query(_)));
    }
    assert_eq!(wb.seq, 1);
}

#[test]
fn replayed_diffs_reproduce_the_workbook_including_undo() {
    let mut live = Workbook::new_empty();
    let snapshot = live.to_snapshot();
    let mut log = Vec::new();
    let mut clip = None;
    let actions = vec![
        Action::UpdateCell {
            sheet: S,
            row: 0,
            col: 0,
            raw: "5".into(),
        },
        Action::UpdateCell {
            sheet: S,
            row: 0,
            col: 1,
            raw: "=A1*2".into(),
        },
        Action::SetStyle {
            range: range(0, 1, 0, 1),
            path: "font.b".into(),
            value: "true".into(),
        },
        Action::InsertRows {
            sheet: S,
            row: 0,
            count: 1,
        },
        Action::Undo,
        Action::UpdateCell {
            sheet: S,
            row: 0,
            col: 0,
            raw: "7".into(),
        },
        Action::Undo,
        Action::Redo,
        Action::AddSheet,
        Action::Merge {
            range: range(3, 0, 4, 1),
        },
    ];
    for a in &actions {
        if let Outcome::Mutated {
            seq, diffs, tables, ..
        } = live.execute(a, &mut clip).unwrap()
        {
            log.push((seq, diffs, tables));
        }
    }
    let mut restored = Workbook::from_snapshot(
        &snapshot.data,
        Some(&snapshot.tables),
        0,
        live.dir().to_path_buf(),
    )
    .unwrap();
    for (seq, diffs, tables) in &log {
        restored.replay(*seq, diffs, tables.as_deref()).unwrap();
    }
    restored.evaluate();
    assert_eq!(restored.seq, live.seq);
    assert_eq!(num(&restored, 0, 1), 14.0);
    assert_eq!(restored.sheets(), live.sheets());
    assert_eq!(restored.sheet_meta(S).unwrap(), live.sheet_meta(S).unwrap());
    assert_eq!(restored.tile(S, 0, 0).unwrap(), live.tile(S, 0, 0).unwrap());
}

#[path = "tests_m2.rs"]
mod m2;

#[path = "tests_m3.rs"]
mod m3;

#[path = "tests_gaps.rs"]
mod gaps;
