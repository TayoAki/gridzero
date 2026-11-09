# vendor/

`ironcalc_base` is IronCalc 0.9.1 from crates.io with one addition,
`UserModel::get_model_mut` (in `src/user_model/common.rs`, marked "GridZero patch").
The engine uses it to write values mirrored from Data Tables and pivots without
recording them in IronCalc's undo history or diff queue. The root `Cargo.toml`
points `ironcalc_base` here with `[patch.crates-io]`.

A second addition, `src/custom_functions.rs` and `Model::custom_functions`, lets a
formula call a Python function: names IronCalc does not know go to that hook before
becoming `#NAME?`. Re-add both when upgrading.

To upgrade: copy the new release here, re-add `get_model_mut`, and bump
`ENGINE_VERSION` in `crates/engine/src/lib.rs`.
