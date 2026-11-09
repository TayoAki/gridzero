# Python sandbox

`runner.py` runs one workbook's module and answers custom-function calls; `gridzero.py` is the SDK user code imports. The workbook host (`crates/wbhost/src/sandbox.rs`) starts one process per workbook inside bubblewrap: no network, an empty environment, a read-only system, and only that workbook's `sandbox/` folder.

The audit hook in `runner.py` is a second layer, and not a security boundary on its own.
