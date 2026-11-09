//! GridZero patch: spreadsheet functions supplied by the embedding application.
//!
//! A call to a name IronCalc does not know reaches `Model::custom_functions` before
//! it becomes `#NAME?`. The hook is runtime state: it is never serialized.

use std::rc::Rc;

use crate::calc_result::CalcResult;
use crate::expressions::parser::Node;
use crate::expressions::token::Error;
use crate::expressions::types::CellReferenceIndex;
use crate::model::Model;

/// An argument to, or the result of, a custom function.
#[derive(Debug, Clone, PartialEq)]
pub enum CustomValue {
    Blank,
    Number(f64),
    Text(String),
    Bool(bool),
    /// Rows of cells. Only as an argument.
    Range(Vec<Vec<CustomValue>>),
    /// A failure, shown as `#VALUE!` with this message.
    Error(String),
}

/// Returns None when the function does not exist.
pub type CustomFunctions = Rc<dyn Fn(&str, &[CustomValue]) -> Option<CustomValue>>;

impl Model<'_> {
    fn custom_scalar(&self, value: CalcResult) -> Result<CustomValue, CalcResult> {
        Ok(match value {
            CalcResult::Number(n) => CustomValue::Number(n),
            CalcResult::String(s) => CustomValue::Text(s),
            CalcResult::Boolean(b) => CustomValue::Bool(b),
            CalcResult::EmptyCell | CalcResult::EmptyArg => CustomValue::Blank,
            error @ CalcResult::Error { .. } => return Err(error),
            _ => CustomValue::Blank,
        })
    }

    fn custom_argument(
        &mut self,
        node: &Node,
        cell: CellReferenceIndex,
    ) -> Result<CustomValue, CalcResult> {
        match self.evaluate_node_in_context(node, cell) {
            CalcResult::Range { left, right } => {
                // A whole column stops at the last used row.
                let last_row = self
                    .workbook
                    .worksheet(left.sheet)
                    .ok()
                    .map(|ws| ws.dimension())
                    .map_or(right.row, |d| right.row.min(d.max_row.max(left.row)));
                let last_col = self
                    .workbook
                    .worksheet(left.sheet)
                    .ok()
                    .map(|ws| ws.dimension())
                    .map_or(right.column, |d| right.column.min(d.max_column.max(left.column)));
                let mut rows = Vec::with_capacity((last_row - left.row + 1) as usize);
                for row in left.row..=last_row {
                    let mut out = Vec::with_capacity((last_col - left.column + 1) as usize);
                    for column in left.column..=last_col {
                        let value = self.evaluate_cell(CellReferenceIndex {
                            sheet: left.sheet,
                            row,
                            column,
                        });
                        out.push(self.custom_scalar(value)?);
                    }
                    rows.push(out);
                }
                Ok(CustomValue::Range(rows))
            }
            other => self.custom_scalar(other),
        }
    }

    /// The result of a custom function, or None if the hook does not know `name`.
    pub(crate) fn call_custom_function(
        &mut self,
        name: &str,
        args: &[Node],
        cell: CellReferenceIndex,
    ) -> Option<CalcResult> {
        let hook = self.custom_functions.clone()?;
        // Ask before evaluating arguments, so unknown names stay cheap.
        hook("", &[CustomValue::Text(name.to_string())])?;
        let mut values = Vec::with_capacity(args.len());
        for arg in args {
            match self.custom_argument(arg, cell) {
                Ok(v) => values.push(v),
                Err(error) => return Some(error),
            }
        }
        Some(match hook(name, &values)? {
            CustomValue::Number(n) => CalcResult::Number(n),
            CustomValue::Text(s) => CalcResult::String(s),
            CustomValue::Bool(b) => CalcResult::Boolean(b),
            CustomValue::Blank => CalcResult::EmptyCell,
            CustomValue::Range(_) => {
                CalcResult::new_error(Error::VALUE, cell, "A function must return one value".into())
            }
            CustomValue::Error(message) => CalcResult::new_error(Error::VALUE, cell, message),
        })
    }
}
