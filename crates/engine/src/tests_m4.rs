//! Pivot groups, table-name references and comments.

use protocol::{Action, Agg, DataTarget, PivotField, PivotSpec, PivotValue, Range, Reply};

use crate::{Outcome, Workbook};

fn run(wb: &mut Workbook, a: Action) -> Reply {
    match wb.execute(&a, &mut None).expect("action works") {
        Outcome::Query(r) | Outcome::Unchanged(r) => r,
        Outcome::Mutated { reply, .. } => reply,
    }
}

fn paste(wb: &mut Workbook, rows: &[&str]) {
    run(
        wb,
        Action::PasteText {
            sheet: 0,
            row: 0,
            col: 0,
            text: rows.join("\n"),
        },
    );
}

fn value(wb: &mut Workbook, row: u32, col: u32) -> String {
    let Reply::Tiles { tiles, .. } = run(
        wb,
        Action::GetTiles {
            sheet: 0,
            tiles: vec![[row / 64, col / 16]],
        },
    ) else {
        panic!("tiles");
    };
    let idx = (row % 64) * 16 + col % 16;
    tiles[0]
        .cells
        .iter()
        .find(|c| c.0 == idx)
        .map(|c| c.1.clone())
        .unwrap_or_default()
}

fn set(wb: &mut Workbook, row: u32, col: u32, raw: &str) {
    run(
        wb,
        Action::UpdateCell {
            sheet: 0,
            row,
            col,
            raw: raw.into(),
        },
    );
}

fn two_level_pivot(wb: &mut Workbook) -> String {
    paste(
        wb,
        &[
            "region\tcity\tunits",
            "East\tBoston\t1",
            "East\tNYC\t2",
            "West\tLA\t4",
            "West\tSF\t8",
        ],
    );
    let spec = PivotSpec {
        id: String::new(),
        sheet: 0,
        row: 0,
        col: 5,
        source: DataTarget::Range {
            range: Range {
                sheet: 0,
                r0: 0,
                c0: 0,
                r1: 4,
                c1: 2,
            },
        },
        rows: vec![
            PivotField {
                field: "region".into(),
                group: None,
            },
            PivotField {
                field: "city".into(),
                group: None,
            },
        ],
        columns: vec![],
        values: vec![PivotValue {
            field: "units".into(),
            agg: Agg::Sum,
            percentile: None,
        }],
        filters: vec![],
        totals: true,
        collapsed: vec![],
    };
    let Reply::Created { id, .. } = run(
        wb,
        Action::CreatePivot {
            spec,
            new_sheet: false,
        },
    ) else {
        panic!("created");
    };
    id
}

#[test]
fn pivot_groups_collapse_and_expand() {
    let mut wb = Workbook::new_empty();
    let id = two_level_pivot(&mut wb);
    assert_eq!(value(&mut wb, 3, 6), "LA");
    run(
        &mut wb,
        Action::TogglePivotGroup {
            id: id.clone(),
            key: vec!["East".into()],
        },
    );
    // East is one row with its total; West keeps its cities; the grand total still adds up.
    assert_eq!(value(&mut wb, 1, 5), "East");
    assert_eq!(value(&mut wb, 1, 6), "");
    assert_eq!(value(&mut wb, 1, 7), "3");
    assert_eq!(value(&mut wb, 2, 6), "LA");
    assert_eq!(value(&mut wb, 4, 5), "Grand Total");
    assert_eq!(value(&mut wb, 4, 7), "15");
    run(
        &mut wb,
        Action::TogglePivotGroup {
            id,
            key: vec!["East".into()],
        },
    );
    assert_eq!(value(&mut wb, 2, 6), "NYC");
}

#[test]
fn structured_references_follow_the_table() {
    let dir = tempfile::tempdir().unwrap();
    let mut wb = Workbook::new_in(dir.path().to_path_buf());
    let staging = wb.dir().join("staging");
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::write(
        staging.join("g1.sales.csv"),
        "region,units
North,1
South,2
East,4
",
    )
    .unwrap();
    let Reply::Imported { table, .. } = run(
        &mut wb,
        Action::FinalizeImport {
            import_id: "g1".into(),
            options: protocol::ImportOptions::default(),
            dest: protocol::ImportDest::NewSheet,
            mode: protocol::ImportMode::Table,
            name: "sales".into(),
        },
    ) else {
        panic!("table");
    };
    let id = table.unwrap();
    set(&mut wb, 9, 0, "=SUM(sales[units])");
    assert_eq!(value(&mut wb, 9, 0), "7");
    let Reply::Cell { raw, .. } = run(
        &mut wb,
        Action::GetCell {
            sheet: 0,
            row: 9,
            col: 0,
        },
    ) else {
        panic!("cell");
    };
    assert_eq!(raw, "=SUM(sales[units])");
    let Reply::Names { names } = run(&mut wb, Action::ListNames) else {
        panic!("names");
    };
    assert!(names.is_empty());

    // Filtering the table changes what the name covers.
    run(
        &mut wb,
        Action::SetFilter {
            target: DataTarget::Table { table: id },
            col: 0,
            filter: Some(protocol::ColumnFilter::Values {
                values: vec!["North".into(), "East".into()],
            }),
        },
    );
    assert_eq!(value(&mut wb, 9, 0), "5");

    // One undo removes the formula, not just its hidden name.
    run(&mut wb, Action::Undo);
    run(&mut wb, Action::Undo);
    assert_eq!(value(&mut wb, 9, 0), "");
}

#[test]
fn comments_move_with_rows_and_survive_sheet_changes() {
    let mut wb = Workbook::new_empty();
    let Reply::Created { id, .. } = run(
        &mut wb,
        Action::AddComment {
            sheet: 0,
            row: 4,
            col: 1,
            text: "check this".into(),
            author: "Ada".into(),
            at: 5,
        },
    ) else {
        panic!("comment");
    };
    run(
        &mut wb,
        Action::ReplyComment {
            id: id.clone(),
            text: "done".into(),
            author: "Grace".into(),
            at: 6,
        },
    );
    run(
        &mut wb,
        Action::InsertRows {
            sheet: 0,
            row: 0,
            count: 2,
        },
    );
    run(&mut wb, Action::ResolveComment { id, resolved: true });
    let Reply::SheetMeta { meta } = run(&mut wb, Action::GetSheetMeta { sheet: 0 }) else {
        panic!("meta");
    };
    assert_eq!(meta.comments.len(), 1);
    let c = &meta.comments[0];
    assert_eq!((c.row, c.col, c.resolved), (6, 1, true));
    assert_eq!(c.replies[0].author, "Grace");
}

#[test]
fn blank_comments_are_refused() {
    let mut wb = Workbook::new_empty();
    let err = wb.execute(
        &Action::AddComment {
            sheet: 0,
            row: 0,
            col: 0,
            text: "   ".into(),
            author: String::new(),
            at: 0,
        },
        &mut None,
    );
    assert!(err.is_err());
}

// Found by the benchmark's formula coverage (bench/formulas.mjs): with ignore_empty,
// Excel skips empty text as well as blank cells.
#[test]
fn textjoin_ignore_empty_skips_empty_text() {
    let mut wb = Workbook::new_empty();
    set(&mut wb, 0, 0, "a");
    set(&mut wb, 1, 0, "=\"\"");
    set(&mut wb, 3, 0, "b");
    set(&mut wb, 0, 2, "=TEXTJOIN(\"-\",TRUE,\"a\",\"\",\"b\")");
    set(&mut wb, 1, 2, "=TEXTJOIN(\"-\",TRUE,A1:A4)");
    set(&mut wb, 2, 2, "=TEXTJOIN(\"-\",FALSE,A1:A4)");
    assert_eq!(value(&mut wb, 0, 2), "a-b");
    assert_eq!(value(&mut wb, 1, 2), "a-b");
    assert_eq!(value(&mut wb, 2, 2), "a---b");
}
