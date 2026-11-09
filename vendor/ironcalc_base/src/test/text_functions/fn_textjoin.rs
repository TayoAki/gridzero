#![allow(clippy::unwrap_used)]

use crate::test::util::new_empty_model;

#[test]
fn simple_cases() {
    let mut model = new_empty_model();
    model._set("A1", "Monday");
    model._set("A2", "Tuesday");
    model._set("A3", "Wednesday");

    model._set("B1", "=TEXTJOIN(\", \", TRUE, A1:A3)");
    model._set("B2", "=TEXTJOIN(\" and \", TRUE, A1:A3)");
    // This formula might have the _xlfn. prefix
    model._set("B3", "=_xlfn.TEXTJOIN(\" or \", , A1:A3)");

    model.evaluate();

    assert_eq!(model._get_text("B1"), *"Monday, Tuesday, Wednesday");
    assert_eq!(model._get_text("B2"), *"Monday and Tuesday and Wednesday");
    assert_eq!(model._get_text("B3"), *"Monday or Tuesday or Wednesday");
    // Our text version removes the prefix, of course (and some white spaces)
    assert_eq!(model._get_formula("B3"), *"=TEXTJOIN(\" or \",,A1:A3)");
}

// Excel skips empty text as well as blank cells when ignore_empty is TRUE.
#[test]
fn ignore_empty_skips_empty_text() {
    let mut model = new_empty_model();
    model._set("A1", "a");
    model._set("A2", "=\"\"");
    model._set("A4", "b");

    model._set("B1", "=TEXTJOIN(\"-\", TRUE, \"a\", \"\", \"b\")");
    model._set("B2", "=TEXTJOIN(\"-\", TRUE, A1:A4)");
    model._set("B3", "=TEXTJOIN(\"-\", FALSE, \"a\", \"\", \"b\")");
    model._set("B4", "=TEXTJOIN(\"-\", FALSE, A1:A4)");

    model.evaluate();

    assert_eq!(model._get_text("B1"), *"a-b");
    assert_eq!(model._get_text("B2"), *"a-b");
    assert_eq!(model._get_text("B3"), *"a--b");
    assert_eq!(model._get_text("B4"), *"a---b");
}

#[test]
fn wrong_number_of_arguments() {
    let mut model = new_empty_model();
    model._set("A1", "Monday");
    model._set("A2", "Tuesday");
    model._set("A3", "Wednesday");

    model._set("B1", "=TEXTJOIN(\", \", TRUE)");
    model._set("B2", "=TEXTJOIN(\" and \", A1:A3)");

    model.evaluate();

    assert_eq!(model._get_text("B1"), *"#ERROR!");
    assert_eq!(model._get_text("B2"), *"#ERROR!");
}

// ── whole-column range and a spill beyond the used area ─────────────────────

// A whole-column range is clipped to the sheet's used area before it is
// walked. Inside an anchor, the column may be spilled on demand during the
// walk, past the bound the walk was clipped to. The skipped part is on
// record, so the spill restarts the pass and the second run sees it all.
#[test]
fn whole_column_sees_a_spill_beyond_the_used_area() {
    let mut model = new_empty_model();
    model._set("A1", "=SEQUENCE(1,1,LEN(TEXTJOIN(\",\",TRUE,D:D)))");
    model._set("C1", "=SEQUENCE(3,1,10)");
    model._set("D1", "=SEQUENCE(5)");
    model.evaluate();
    assert_eq!(model._get_text("A1"), "9");
    assert_eq!(model.evaluation.restarts_in_last_evaluation, 1);

    model.evaluate();
    assert_eq!(model._get_text("A1"), "9");
    assert_eq!(model.evaluation.restarts_in_last_evaluation, 0);
}
