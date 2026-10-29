//! Keeping object references on the same cells when rows or columns are inserted or
//! deleted (BUILD-SPEC §11 M3: "chart expressions survive insert/delete of rows").
//! IronCalc shifts cell formulas itself; this does the same for everything in the
//! manifest that points at cells: table and pivot anchors, chart series, slicers,
//! filtered ranges, validation ranges and range sources.

use protocol::{DataTarget, Range};

use crate::Manifest;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dim {
    Rows,
    Cols,
}

/// An insert (`delta` > 0) or delete (`delta` < 0) of |delta| rows/columns starting at `at`.
#[derive(Debug, Clone, Copy)]
pub struct Shift {
    pub sheet: u32,
    pub dim: Dim,
    pub at: u32,
    pub delta: i64,
}

impl Shift {
    /// Where a single row/column index ends up; deleted positions collapse to `at`.
    pub fn point(&self, p: u32) -> u32 {
        let (at, n) = (self.at as i64, self.delta);
        let p = p as i64;
        let out = if n > 0 {
            if p >= at {
                p + n
            } else {
                p
            }
        } else if p >= at - n {
            p + n
        } else if p >= at {
            at
        } else {
            p
        };
        out.max(0) as u32
    }

    /// A span [a, b] after the change, or None when all of it was deleted.
    fn span(&self, a: u32, b: u32) -> Option<(u32, u32)> {
        let (at, n) = (self.at as i64, self.delta);
        let (a, b) = (a as i64, b as i64);
        if n > 0 {
            let a2 = if a >= at { a + n } else { a };
            let b2 = if b >= at { b + n } else { b };
            return Some((a2 as u32, b2 as u32));
        }
        let end = at - n; // first index after the deleted block
        let map_start = |p: i64| {
            if p >= end {
                p + n
            } else if p >= at {
                at
            } else {
                p
            }
        };
        let map_end = |p: i64| {
            if p >= end {
                p + n
            } else if p >= at {
                at - 1
            } else {
                p
            }
        };
        let (a2, b2) = (map_start(a), map_end(b));
        (b2 >= a2 && b2 >= 0).then_some((a2 as u32, b2 as u32))
    }

    pub fn range(&self, r: &Range) -> Option<Range> {
        if r.sheet != self.sheet {
            return Some(*r);
        }
        let mut out = *r;
        match self.dim {
            Dim::Rows => {
                let (a, b) = self.span(r.r0, r.r1)?;
                out.r0 = a;
                out.r1 = b;
            }
            Dim::Cols => {
                let (a, b) = self.span(r.c0, r.c1)?;
                out.c0 = a;
                out.c1 = b;
            }
        }
        Some(out)
    }

    fn anchor(&self, sheet: u32, row: &mut u32, col: &mut u32) {
        if sheet != self.sheet {
            return;
        }
        match self.dim {
            Dim::Rows => *row = self.point(*row),
            Dim::Cols => *col = self.point(*col),
        }
    }
}

fn target(s: &Shift, t: &mut DataTarget) -> bool {
    match t {
        DataTarget::Range { range } => match s.range(range) {
            Some(r) => {
                *range = r;
                true
            }
            None => false,
        },
        DataTarget::Table { .. } => true,
    }
}

/// Apply a row/column insert or delete to every reference in the manifest.
pub fn apply(m: &mut Manifest, s: Shift) {
    for t in &mut m.tables {
        s.anchor(t.sheet, &mut t.row, &mut t.col);
    }
    m.range_filters.retain_mut(|f| match s.range(&f.range) {
        Some(r) => {
            let old = f.range;
            f.range = r;
            if s.dim == Dim::Cols && old.sheet == s.sheet {
                f.filters.retain_mut(|(c, _)| {
                    let deleted = s.delta < 0 && *c >= s.at && (*c as i64) < s.at as i64 - s.delta;
                    *c = s.point(*c);
                    !deleted
                });
            }
            true
        }
        None => false,
    });
    m.cell_imports.retain_mut(|c| {
        let r = Range {
            sheet: c.sheet,
            r0: c.row,
            c0: c.col,
            r1: c.row + c.rows.max(1) - 1,
            c1: c.col + c.cols.max(1) - 1,
        };
        match s.range(&r) {
            Some(r) => {
                (c.row, c.col, c.rows, c.cols) = (r.r0, r.c0, r.r1 - r.r0 + 1, r.c1 - r.c0 + 1);
                true
            }
            None => false,
        }
    });
    m.pivots.retain_mut(|p| {
        s.anchor(p.sheet, &mut p.row, &mut p.col);
        target(&s, &mut p.source)
    });
    for c in &mut m.charts {
        s.anchor(c.sheet, &mut c.row, &mut c.col);
        c.x = c.x.and_then(|r| s.range(&r));
        for series in &mut c.series {
            series.range = series.range.and_then(|r| s.range(&r));
        }
    }
    m.slicers.retain_mut(|sl| {
        s.anchor(sl.sheet, &mut sl.row, &mut sl.col);
        if let DataTarget::Range { range } = &sl.target {
            if s.dim == Dim::Cols && range.sheet == s.sheet {
                sl.column = s.point(sl.column);
            }
        }
        target(&s, &mut sl.target)
    });
    m.validations.retain_mut(|v| {
        v.source = v.source.and_then(|r| s.range(&r));
        match s.range(&v.range) {
            Some(r) => {
                v.range = r;
                true
            }
            None => false,
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(r0: u32, r1: u32) -> Range {
        Range {
            sheet: 0,
            r0,
            c0: 1,
            r1,
            c1: 1,
        }
    }

    #[test]
    fn rows_insert_and_delete() {
        let ins = Shift {
            sheet: 0,
            dim: Dim::Rows,
            at: 3,
            delta: 2,
        };
        assert_eq!(ins.range(&r(1, 9)), Some(r(1, 11))); // grows across the insert
        assert_eq!(ins.range(&r(3, 9)), Some(r(5, 11))); // insert at the top edge moves it
        assert_eq!(ins.range(&r(0, 2)), Some(r(0, 2)));
        let del = Shift {
            sheet: 0,
            dim: Dim::Rows,
            at: 3,
            delta: -2,
        };
        assert_eq!(del.range(&r(1, 9)), Some(r(1, 7)));
        assert_eq!(del.range(&r(4, 9)), Some(r(3, 7))); // trimmed at the start
        assert_eq!(del.range(&r(1, 3)), Some(r(1, 2))); // trimmed at the end
        assert_eq!(del.range(&r(3, 4)), None); // all deleted
        assert_eq!(del.point(10), 8);
        let other = Shift { sheet: 1, ..del };
        assert_eq!(other.range(&r(3, 4)), Some(r(3, 4)));
    }
}
