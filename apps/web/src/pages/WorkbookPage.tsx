import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Link, useParams } from "react-router";

import { CanvasGrid, columnName, parseRef } from "../grid/grid";
import type { CellPos, CellRange, Command, Hit } from "../grid/grid";
import { FontFlag, TILE_COLS, TILE_ROWS, TileCache } from "../grid/tiles";
import type { CellStyle } from "../grid/tiles";
import { SheetSocket } from "../sheet-socket";
import type { Action, BorderKind, DocState, Grant, Range, Reply, SheetInfo } from "../sheet-socket";

// Excel's sheet limits; the server enforces the same bounds.
const ROWS = 1_048_576;
const COLS = 16_384;

const NUMBER_FORMATS: [string, string][] = [
  ["general", "General"],
  ["#,##0", "Number (1,234)"],
  ["#,##0.00", "Number (1,234.50)"],
  ["$#,##0.00", "Currency ($)"],
  ["0%", "Percent (12%)"],
  ["0.00%", "Percent (12.34%)"],
  ["yyyy-mm-dd", "Date (2025-01-31)"],
  ["mm/dd/yyyy", "Date (01/31/2025)"],
  ["@", "Text"],
];

interface Editor {
  value: string;
  // Where the edit started, so a click elsewhere commits to the right cell.
  pos: CellPos;
  // Which input owns keyboard focus; the other one mirrors the value.
  via: "cell" | "bar";
}

interface Menu {
  x: number;
  y: number;
  items: ([string, () => void] | "-")[];
}

export function WorkbookPage() {
  const { id = "" } = useParams();
  const hostRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<CanvasGrid | null>(null);
  const cacheRef = useRef<TileCache | null>(null);
  const socketRef = useRef<SheetSocket | null>(null);
  const sheetRef = useRef(0);
  const copiedRef = useRef<string | null>(null);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocState>({ seq: 0, sheets: [], can_undo: false, can_redo: false });
  const [sheet, setSheet] = useState(0);
  const [focus, setFocus] = useState<CellPos>({ row: 0, col: 0 });
  const [sel, setSel] = useState<CellRange>({ r0: 0, c0: 0, r1: 0, c1: 0 });
  const [formula, setFormula] = useState("");
  const [nameBox, setNameBox] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [find, setFind] = useState<{ text: string; replace: string; note: string } | null>(null);
  const [stats, setStats] = useState<Extract<Reply, { k: "Stats" }> | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [, setTick] = useState(0);
  const editorRef = useRef<HTMLInputElement>(null);
  // Latest editor state for grid callbacks that were bound once.
  const editorState = useRef<Editor | null>(null);
  editorState.current = editor;

  const send = (action: Action) => {
    const socket = socketRef.current;
    if (!socket) return Promise.reject(new Error("not connected"));
    return socket.send(action).catch((e: Error) => {
      if (e.message !== "not connected" && e.message !== "connection closed") setError(e.message);
      throw e;
    });
  };
  const mutate = (action: Action) => void send(action).catch(() => {});
  const range = (): Range => ({ sheet: sheetRef.current, ...gridRef.current!.selection() });

  useEffect(() => {
    const host = hostRef.current!;
    const grant = async (): Promise<Grant> => {
      const res = await fetch(`/api/v1/workbooks/${id}/open`, { method: "POST", credentials: "include" });
      if (!res.ok) {
        setError(res.status === 404 ? "Workbook not found" : `Could not open workbook (${res.status})`);
        throw new Error(`open failed: ${res.status}`);
      }
      const body = await res.json();
      setTitle(body.title);
      setError(null);
      return body;
    };
    const socket = new SheetSocket(grant);
    const cache = new TileCache(
      {
        requestTiles(s, tiles) {
          const gen = cache.generation;
          socket.send({ type: "GetTiles", sheet: s, tiles }).then(
            (m) => m.k === "Tiles" && cache.receive(m.sheet, m.tiles, gen),
            () => {},
          );
        },
      },
      () => {
        grid.invalidate();
        setTick((t) => t + 1);
      },
    );
    const grid = new CanvasGrid(host, cache, { rows: ROWS, cols: COLS });

    const loadFormula = (pos: CellPos) =>
      socket.send({ type: "GetCell", sheet: sheetRef.current, row: pos.row, col: pos.col }).then(
        (m) => m.k === "Cell" && m.row === grid.focus.row && m.col === grid.focus.col && setFormula(m.raw),
        () => {},
      );
    const loadMeta = () =>
      socket.send({ type: "GetSheetMeta", sheet: sheetRef.current }).then(
        (m) => {
          if (m.k !== "SheetMeta" || m.meta.sheet !== sheetRef.current) return;
          const meta = m.meta;
          grid.setLayout({
            defaultColWidth: meta.default_col_width,
            defaultRowHeight: meta.default_row_height,
            colWidths: meta.col_widths,
            rowHeights: meta.row_heights,
            frozenRows: meta.frozen_rows,
            frozenCols: meta.frozen_cols,
            merges: meta.merges,
            showGrid: meta.show_grid,
          });
        },
        () => {},
      );
    let statsTimer = 0;
    const loadStats = () => {
      window.clearTimeout(statsTimer);
      statsTimer = window.setTimeout(() => {
        socket.send({ type: "SelectionStats", range: { sheet: sheetRef.current, ...grid.selection() } }).then(
          (m) => m.k === "Stats" && setStats(m),
          () => {},
        );
      }, 120);
    };
    const applyDoc = (state: DocState) => {
      setDoc(state);
      if (sheetRef.current >= state.sheets.length) switchSheet(Math.max(0, state.sheets.length - 1));
    };
    const switchSheet = (s: number) => {
      sheetRef.current = s;
      setSheet(s);
      cache.setSheet(s);
      grid.select({ row: 0, col: 0 });
      void loadMeta();
    };
    switchSheetRef.current = switchSheet;

    socket.onStatus = (s) => {
      setStatus(s);
      // Requests made while disconnected were dropped; re-request everything visible.
      if (s === "open") cache.invalidate();
    };
    socket.onWelcome = (state) => {
      setReadOnly(socket.role === "viewer");
      applyDoc(state);
      void loadMeta();
      void loadFormula(grid.focus);
    };
    socket.onChanged = (state) => {
      applyDoc(state);
      cache.invalidate();
      void loadMeta();
      void loadFormula(grid.focus);
      loadStats();
    };
    grid.onSelect = (pos) => {
      setFocus(pos);
      setSel(grid.selection());
      void loadFormula(pos);
      loadStats();
    };
    grid.onEditRequest = (initial) => {
      if (socket.role === "viewer") return;
      // Fast typing can deliver more text to the grid before the editor takes focus; append it.
      if (editorState.current && initial !== undefined) {
        setEditor((e) => (e ? { ...e, value: e.value + initial } : e));
        return;
      }
      const pos = { ...grid.focus };
      setEditor({ value: initial ?? "", pos, via: "cell" });
      if (initial === undefined) {
        // F2 / double-click edits the existing contents.
        socket.send({ type: "GetCell", sheet: sheetRef.current, row: pos.row, col: pos.col }).then(
          (m) => m.k === "Cell" && setEditor((e) => (e && e.pos.row === m.row && e.pos.col === m.col ? { ...e, value: m.raw } : e)),
          () => {},
        );
      }
    };
    grid.onCommand = (command) => commandRef.current(command);
    grid.onJump = (dir, extend) => {
      const from = grid.focus;
      socket.send({ type: "CtrlJump", sheet: sheetRef.current, row: from.row, col: from.col, dir }).then(
        (m) => m.k === "Position" && grid.select({ row: m.row, col: m.col }, extend),
        () => {},
      );
    };
    grid.onPasteText = (text) => pasteRef.current(text);
    grid.onResize = (axis, index, size) => {
      const s = grid.selection();
      // Resizing a header inside a whole-column/row selection resizes all of them.
      const many = axis === "col" ? s.r0 === 0 && s.r1 === ROWS - 1 && index >= s.c0 && index <= s.c1 : s.c0 === 0 && s.c1 === COLS - 1 && index >= s.r0 && index <= s.r1;
      const [a, b] = many ? (axis === "col" ? [s.c0, s.c1] : [s.r0, s.r1]) : [index, index];
      void socket
        .send(axis === "col" ? { type: "SetColWidth", sheet: sheetRef.current, c0: a, c1: b, width: size } : { type: "SetRowHeight", sheet: sheetRef.current, r0: a, r1: b, height: size })
        .catch(() => loadMeta());
    };
    grid.onContextMenu = (hit, x, y) => menuRef.current(hit, x, y);

    gridRef.current = grid;
    cacheRef.current = cache;
    socketRef.current = socket;
    // Dev-only handle for browser tests and debugging.
    if (import.meta.env.DEV) Object.assign(window, { __gz: { grid, cache, socket } });
    grid.focusCanvas();
    return () => {
      window.clearTimeout(statsTimer);
      socket.close();
      grid.destroy();
    };
  }, [id]);

  const switchSheetRef = useRef<(s: number) => void>(() => {});

  useEffect(() => {
    if (editor?.via === "cell") editorRef.current?.focus();
  }, [editor === null, editor?.via]);

  // ------------------------------------------------------------- actions

  function styleAt(pos: CellPos): CellStyle | undefined {
    const tile = cacheRef.current?.get(Math.floor(pos.row / TILE_ROWS), Math.floor(pos.col / TILE_COLS));
    if (!tile) return undefined;
    const i = (pos.row % TILE_ROWS) * TILE_COLS + (pos.col % TILE_COLS);
    return tile.styles[tile.style[i]];
  }

  function toggleFont(path: string, flag: FontFlag) {
    const on = ((styleAt(focus)?.font ?? 0) & flag) !== 0;
    mutate({ type: "SetStyle", range: range(), path, value: String(!on) });
  }

  function setStyle(path: string, value: string) {
    mutate({ type: "SetStyle", range: range(), path, value });
    gridRef.current?.focusCanvas();
  }

  async function copy(cut: boolean) {
    try {
      const reply = await send({ type: "CopyRange", range: range(), cut });
      if (reply.k !== "Text") return;
      copiedRef.current = normalize(reply.text);
      await navigator.clipboard.writeText(reply.text).catch(() => {});
    } catch {
      /* reported by send */
    }
  }

  function paste(text: string) {
    if (readOnly) return;
    const { r0: row, c0: col } = gridRef.current!.selection();
    // Our own copy pastes from the server-side clipboard, keeping formulas and styles.
    if (copiedRef.current !== null && normalize(text) === copiedRef.current) {
      mutate({ type: "PasteInternal", sheet: sheetRef.current, row, col });
    } else {
      mutate({ type: "PasteText", sheet: sheetRef.current, row, col, text });
    }
  }
  const pasteRef = useRef(paste);
  pasteRef.current = paste;

  function fill(dir: "down" | "right") {
    const s = gridRef.current!.selection();
    const sheetNo = sheetRef.current;
    if (dir === "down") {
      // A single selected row copies from the row above, as in Excel.
      if (s.r0 === s.r1 && s.r0 > 0) mutate({ type: "Fill", source: { sheet: sheetNo, r0: s.r0 - 1, r1: s.r0 - 1, c0: s.c0, c1: s.c1 }, to_row: s.r0, to_col: null });
      else if (s.r1 > s.r0) mutate({ type: "Fill", source: { sheet: sheetNo, r0: s.r0, r1: s.r0, c0: s.c0, c1: s.c1 }, to_row: s.r1, to_col: null });
    } else if (s.c0 === s.c1 && s.c0 > 0) {
      mutate({ type: "Fill", source: { sheet: sheetNo, r0: s.r0, r1: s.r1, c0: s.c0 - 1, c1: s.c0 - 1 }, to_row: null, to_col: s.c0 });
    } else if (s.c1 > s.c0) {
      mutate({ type: "Fill", source: { sheet: sheetNo, r0: s.r0, r1: s.r1, c0: s.c0, c1: s.c0 }, to_row: null, to_col: s.c1 });
    }
  }

  function command(c: Command) {
    const grid = gridRef.current!;
    switch (c) {
      case "undo":
        return mutate({ type: "Undo" });
      case "redo":
        return mutate({ type: "Redo" });
      case "copy":
        return void copy(false);
      case "cut":
        return void copy(true);
      case "selectAll":
        return grid.selectRange({ r0: 0, c0: 0, r1: ROWS - 1, c1: COLS - 1 });
      case "fillDown":
        return fill("down");
      case "fillRight":
        return fill("right");
      case "bold":
        return toggleFont("font.b", FontFlag.Bold);
      case "italic":
        return toggleFont("font.i", FontFlag.Italic);
      case "underline":
        return toggleFont("font.u", FontFlag.Underline);
      case "find":
        return setFind((f) => f ?? { text: "", replace: "", note: "" });
      case "clear":
        if (!readOnly) mutate({ type: "ClearRange", range: range(), formats: false });
    }
  }
  const commandRef = useRef(command);
  commandRef.current = command;

  function openMenu(hit: Hit, x: number, y: number) {
    const s = gridRef.current!.selection();
    const sheetNo = sheetRef.current;
    const items: Menu["items"] = [
      ["Cut", () => void copy(true)],
      ["Copy", () => void copy(false)],
      ["Paste", () => void navigator.clipboard.readText().then(paste, () => setError("Use Ctrl+V to paste (clipboard access was blocked)"))],
      "-",
    ];
    if (hit.kind === "colHeader" || hit.kind === "cell") {
      const n = s.c1 - s.c0 + 1;
      items.push(
        [`Insert ${n} column${n > 1 ? "s" : ""} left`, () => mutate({ type: "InsertCols", sheet: sheetNo, col: s.c0, count: n })],
        [`Insert ${n} column${n > 1 ? "s" : ""} right`, () => mutate({ type: "InsertCols", sheet: sheetNo, col: s.c1 + 1, count: n })],
        [`Delete column${n > 1 ? "s" : ""}`, () => mutate({ type: "DeleteCols", sheet: sheetNo, col: s.c0, count: n })],
      );
    }
    if (hit.kind === "rowHeader" || hit.kind === "cell") {
      const n = s.r1 - s.r0 + 1;
      items.push(
        [`Insert ${n} row${n > 1 ? "s" : ""} above`, () => mutate({ type: "InsertRows", sheet: sheetNo, row: s.r0, count: n })],
        [`Insert ${n} row${n > 1 ? "s" : ""} below`, () => mutate({ type: "InsertRows", sheet: sheetNo, row: s.r1 + 1, count: n })],
        [`Delete row${n > 1 ? "s" : ""}`, () => mutate({ type: "DeleteRows", sheet: sheetNo, row: s.r0, count: n })],
      );
    }
    items.push("-", ["Clear contents", () => mutate({ type: "ClearRange", range: range(), formats: false })], ["Clear all (incl. formats)", () => mutate({ type: "ClearRange", range: range(), formats: true })]);
    if (readOnly) items.splice(0, items.length, ["Copy", () => void copy(false)]);
    setMenu({ x, y, items });
  }
  const menuRef = useRef(openMenu);
  menuRef.current = openMenu;

  function sheetMenu(s: SheetInfo, x: number, y: number) {
    if (readOnly) return;
    setMenu({
      x,
      y: y - 160,
      items: [
        ["Rename", () => renameSheet(s)],
        ["Duplicate", () => mutate({ type: "DuplicateSheet", sheet: s.id })],
        ["Move left", () => s.id > 0 && mutate({ type: "MoveSheet", sheet: s.id, to: s.id - 1 })],
        ["Move right", () => s.id < doc.sheets.length - 1 && mutate({ type: "MoveSheet", sheet: s.id, to: s.id + 1 })],
        ["Tab color…", () => {
          const color = window.prompt("Tab color (#RRGGBB)", s.color ?? "#1A73E8");
          if (color && /^#[0-9a-fA-F]{6}$/.test(color)) mutate({ type: "SetSheetColor", sheet: s.id, color: color.toUpperCase() });
        }],
        ["Hide", () => mutate({ type: "SetSheetHidden", sheet: s.id, hidden: true })],
        "-",
        ["Delete", () => doc.sheets.filter((x) => !x.hidden).length > 1 && window.confirm(`Delete sheet "${s.name}"?`) && mutate({ type: "DeleteSheet", sheet: s.id })],
      ],
    });
  }

  function renameSheet(s: SheetInfo) {
    setRenaming({ id: s.id, name: s.name });
  }

  function finishRename(save: boolean) {
    const r = renaming;
    setRenaming(null);
    const current = doc.sheets.find((s) => s.id === r?.id);
    if (save && r && current && r.name.trim() && r.name.trim() !== current.name) mutate({ type: "RenameSheet", sheet: r.id, name: r.name.trim() });
    gridRef.current?.focusCanvas();
  }

  async function submitNameBox(text: string) {
    setNameBox(null);
    const grid = gridRef.current!;
    const t = text.trim();
    if (!t) return;
    const ref = parseRef(t);
    if (ref) {
      grid.select({ row: ref.r0, col: ref.c0 });
      if (ref.r1 !== ref.r0 || ref.c1 !== ref.c0) grid.selectRange(ref);
      grid.focusCanvas();
      return;
    }
    // An existing name jumps to its range; a new valid name is defined on the selection.
    const names = await send({ type: "ListNames" }).catch(() => null);
    const existing = names?.k === "Names" ? names.names.find((n) => n.name.toLowerCase() === t.toLowerCase()) : undefined;
    if (existing) {
      const target = parseRef(existing.formula);
      const sheetName = existing.formula.includes("!") ? existing.formula.split("!")[0].replace(/^'|'$/g, "") : null;
      const sheetNo = sheetName ? doc.sheets.findIndex((s) => s.name === sheetName) : sheetRef.current;
      if (sheetNo >= 0 && sheetNo !== sheetRef.current) switchSheetRef.current(sheetNo);
      if (target) window.setTimeout(() => grid.selectRange(target), sheetNo !== sheetRef.current ? 50 : 0);
    } else if (!readOnly) {
      const s = grid.selection();
      const sheetName = doc.sheets[sheetRef.current]?.name ?? "Sheet1";
      const abs = `$${columnName(s.c0)}$${s.r0 + 1}` + (s.r1 !== s.r0 || s.c1 !== s.c0 ? `:$${columnName(s.c1)}$${s.r1 + 1}` : "");
      mutate({ type: "CreateName", name: t, scope: null, formula: `'${sheetName.replace(/'/g, "''")}'!${abs}` });
    }
    grid.focusCanvas();
  }

  async function findNext() {
    if (!find?.text) return;
    const grid = gridRef.current!;
    const reply = await send({ type: "Find", sheet: sheetRef.current, row: grid.focus.row, col: grid.focus.col, text: find.text }).catch(() => null);
    if (reply?.k === "Position") {
      grid.select({ row: reply.row, col: reply.col });
      setFind((f) => f && { ...f, note: "" });
    } else {
      setFind((f) => f && { ...f, note: "No matches" });
    }
  }

  function replaceAll() {
    if (!find?.text || readOnly) return;
    mutate({ type: "ReplaceAll", sheet: sheetRef.current, find: find.text, replace: find.replace });
    setFind((f) => f && { ...f, note: "Replaced" });
  }

  function freezeAtSelection() {
    const f = gridRef.current!.focus;
    mutate({ type: "Freeze", sheet: sheetRef.current, rows: f.row, cols: f.col });
  }

  function border(kind: BorderKind) {
    mutate({ type: "SetBorder", range: range(), kind, style: "thin", color: "#000000" });
    gridRef.current?.focusCanvas();
  }

  // ------------------------------------------------------------- editing

  function commit(edit: Editor) {
    mutate({ type: "UpdateCell", sheet: sheetRef.current, row: edit.pos.row, col: edit.pos.col, raw: edit.value });
  }

  function finishEdit(dRow: number, dCol: number) {
    const current = editorState.current;
    // Clear the ref now: moving focus below blurs the editor before React re-renders,
    // and its onBlur would otherwise commit the same edit a second time.
    editorState.current = null;
    setEditor(null);
    const grid = gridRef.current!;
    if (current) commit(current);
    if (dRow || dCol) grid.moveFocus(dRow, dCol);
    grid.focusCanvas();
  }

  function onEditorKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      finishEdit(e.shiftKey ? -1 : 1, 0);
    } else if (e.key === "Tab") {
      e.preventDefault();
      finishEdit(0, e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      editorState.current = null;
      setEditor(null);
      gridRef.current?.focusCanvas();
    }
  }

  async function saveTitle(next: string) {
    const trimmed = next.trim();
    if (!trimmed || trimmed === title) return;
    const res = await fetch(`/api/v1/workbooks/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: trimmed }),
    });
    if (res.ok) setTitle(trimmed);
  }

  const grid = gridRef.current;
  const rect = editor && grid?.visibleCellRect(editor.pos.row, editor.pos.col);
  const focusStyle = styleAt(focus);
  const font = focusStyle?.font ?? 0;
  const selLabel = sel.r0 === 0 && sel.r1 === ROWS - 1 && sel.c0 === 0 && sel.c1 === COLS - 1
    ? "All"
    : sel.r0 === 0 && sel.r1 === ROWS - 1
      ? `${columnName(sel.c0)}:${columnName(sel.c1)}`
      : sel.c0 === 0 && sel.c1 === COLS - 1
        ? `${sel.r0 + 1}:${sel.r1 + 1}`
        : sel.r0 === sel.r1 && sel.c0 === sel.c1
          ? `${columnName(focus.col)}${focus.row + 1}`
          : `${columnName(sel.c0)}${sel.r0 + 1}:${columnName(sel.c1)}${sel.r1 + 1}`;
  const visibleSheets = doc.sheets.filter((s) => !s.hidden);
  const hiddenSheets = doc.sheets.filter((s) => s.hidden);

  return (
    <div className="workbook" onClick={() => menu && setMenu(null)}>
      <header className="wb-header">
        <Link to="/" className="wb-home" aria-label="Back to home">GridZero</Link>
        <input
          className="wb-title"
          aria-label="Workbook title"
          defaultValue={title}
          key={title}
          readOnly={readOnly}
          onBlur={(e) => void saveTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        {readOnly && <span className="wb-badge">View only</span>}
        <span className={`wb-status wb-status-${status}`}>{status === "open" ? "Saved" : status === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
      </header>

      <div className="wb-toolbar" role="toolbar" aria-label="Formatting" onMouseDown={(e) => e.target instanceof HTMLButtonElement && e.preventDefault()}>
        <Tool label="Undo (Ctrl+Z)" disabled={!doc.can_undo || readOnly} onClick={() => command("undo")}>↶</Tool>
        <Tool label="Redo (Ctrl+Y)" disabled={!doc.can_redo || readOnly} onClick={() => command("redo")}>↷</Tool>
        <Sep />
        <Tool label="Bold (Ctrl+B)" pressed={!!(font & FontFlag.Bold)} disabled={readOnly} onClick={() => command("bold")}><b>B</b></Tool>
        <Tool label="Italic (Ctrl+I)" pressed={!!(font & FontFlag.Italic)} disabled={readOnly} onClick={() => command("italic")}><i>I</i></Tool>
        <Tool label="Underline (Ctrl+U)" pressed={!!(font & FontFlag.Underline)} disabled={readOnly} onClick={() => command("underline")}><u>U</u></Tool>
        <Tool label="Strikethrough" pressed={!!(font & FontFlag.Strike)} disabled={readOnly} onClick={() => toggleFont("font.strike", FontFlag.Strike)}><s>S</s></Tool>
        <label className="wb-color" title="Text color">
          A<input type="color" aria-label="Text color" disabled={readOnly} value={focusStyle?.color ?? "#000000"} onChange={(e) => setStyle("font.color", e.target.value.toUpperCase())} />
        </label>
        <label className="wb-color wb-fill" title="Fill color">
          ▧<input type="color" aria-label="Fill color" disabled={readOnly} value={focusStyle?.fill ?? "#ffffff"} onChange={(e) => setStyle("fill.color", e.target.value.toUpperCase())} />
        </label>
        <Sep />
        <select aria-label="Number format" className="wb-select" disabled={readOnly} value="" onChange={(e) => e.target.value && setStyle("num_fmt", e.target.value)}>
          <option value="">Format…</option>
          {NUMBER_FORMATS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select>
        <Sep />
        <Tool label="Align left" pressed={focusStyle?.align === "left"} disabled={readOnly} onClick={() => setStyle("alignment.horizontal", "left")}>⇤</Tool>
        <Tool label="Align center" pressed={focusStyle?.align === "center"} disabled={readOnly} onClick={() => setStyle("alignment.horizontal", "center")}>≡</Tool>
        <Tool label="Align right" pressed={focusStyle?.align === "right"} disabled={readOnly} onClick={() => setStyle("alignment.horizontal", "right")}>⇥</Tool>
        <Tool label="Wrap text" pressed={!!(font & FontFlag.Wrap)} disabled={readOnly} onClick={() => setStyle("alignment.wrap_text", String(!(font & FontFlag.Wrap)))}>↵</Tool>
        <Sep />
        <select aria-label="Borders" className="wb-select" disabled={readOnly} value="" onChange={(e) => e.target.value && border(e.target.value as BorderKind)}>
          <option value="">Borders…</option>
          <option value="All">All borders</option>
          <option value="Outer">Outside borders</option>
          <option value="Inner">Inside borders</option>
          <option value="Top">Top</option>
          <option value="Bottom">Bottom</option>
          <option value="Left">Left</option>
          <option value="Right">Right</option>
          <option value="None">No borders</option>
        </select>
        <Tool label="Merge cells" disabled={readOnly} onClick={() => mutate({ type: "Merge", range: range() })}>⊞</Tool>
        <Tool label="Unmerge cells" disabled={readOnly} onClick={() => mutate({ type: "Unmerge", range: range() })}>⊟</Tool>
        <Sep />
        <Tool label="Freeze panes above and left of the selected cell" disabled={readOnly} onClick={freezeAtSelection}>❄</Tool>
        <Tool label="Unfreeze panes" disabled={readOnly || (!grid?.frozenRows && !grid?.frozenCols)} onClick={() => mutate({ type: "Freeze", sheet: sheetRef.current, rows: 0, cols: 0 })}>☀</Tool>
        <Tool label="Toggle gridlines" pressed={grid?.showGrid ?? true} disabled={readOnly} onClick={() => mutate({ type: "SetGridlines", sheet: sheetRef.current, show: !(grid?.showGrid ?? true) })}>#</Tool>
        <Tool label="Find and replace (Ctrl+F)" onClick={() => command("find")}>⌕</Tool>
      </div>

      {error && (
        <p className="wb-error" role="alert">
          {error} <button className="link-button" onClick={() => setError(null)}>Dismiss</button>
        </p>
      )}

      {find && (
        <div className="wb-find" role="search">
          <input aria-label="Find" placeholder="Find" autoFocus value={find.text} onChange={(e) => setFind({ ...find, text: e.target.value, note: "" })} onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void findNext(); }
            if (e.key === "Escape") { e.preventDefault(); setFind(null); gridRef.current?.focusCanvas(); }
          }} />
          <button onClick={() => void findNext()}>Find next</button>
          {!readOnly && (
            <>
              <input aria-label="Replace with" placeholder="Replace with" value={find.replace} onChange={(e) => setFind({ ...find, replace: e.target.value })} />
              <button onClick={replaceAll}>Replace all</button>
            </>
          )}
          <span className="wb-find-note">{find.note}</span>
          <button className="link-button" onClick={() => { setFind(null); gridRef.current?.focusCanvas(); }}>Close</button>
        </div>
      )}

      <div className="wb-formula-bar">
        <input
          className="wb-namebox"
          aria-label="Name box"
          value={nameBox ?? selLabel}
          onFocus={(e) => { setNameBox(selLabel); e.target.select(); }}
          onChange={(e) => setNameBox(e.target.value)}
          onBlur={() => setNameBox(null)}
          onKeyDown={(e) => {
            // preventDefault: focus moves to the grid's hidden input during this keydown,
            // and Enter's default action would otherwise type a newline into it.
            if (e.key === "Enter") { e.preventDefault(); void submitNameBox(nameBox ?? ""); }
            if (e.key === "Escape") { e.preventDefault(); setNameBox(null); gridRef.current?.focusCanvas(); }
          }}
        />
        <input
          className="wb-formula"
          aria-label="Formula bar"
          readOnly={readOnly}
          value={editor ? editor.value : formula}
          onFocus={() => !readOnly && setEditor((ed) => (ed ? { ...ed, via: "bar" } : { value: formula, pos: { ...focus }, via: "bar" }))}
          onChange={(e) => setEditor((ed) => (ed ? { ...ed, value: e.target.value } : { value: e.target.value, pos: { ...focus }, via: "bar" }))}
          onKeyDown={onEditorKey}
          onBlur={() => editorState.current?.via === "bar" && finishEdit(0, 0)}
        />
      </div>

      <div className="wb-grid" ref={hostRef}>
        {editor && rect && (
          <input
            ref={editorRef}
            className="wb-cell-editor"
            aria-label="Cell editor"
            style={{ left: rect.x, top: rect.y, width: Math.max(rect.w, 120), height: rect.h }}
            value={editor.value}
            onChange={(e) => setEditor({ ...editor, value: e.target.value })}
            onKeyDown={onEditorKey}
            onFocus={() => setEditor((ed) => (ed ? { ...ed, via: "cell" } : ed))}
            onBlur={() => editorState.current?.via === "cell" && finishEdit(0, 0)}
          />
        )}
      </div>

      <footer className="wb-footer">
        <div className="wb-tabs" role="tablist" aria-label="Sheets">
          {visibleSheets.map((s) => renaming?.id === s.id ? (
            <input
              key={s.id}
              className="wb-tab wb-tab-rename"
              aria-label="Sheet name"
              autoFocus
              value={renaming.name}
              onChange={(e) => setRenaming({ id: s.id, name: e.target.value })}
              onBlur={() => finishRename(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); finishRename(true); }
                if (e.key === "Escape") { e.preventDefault(); finishRename(false); }
              }}
            />
          ) : (
            <button
              key={s.id}
              role="tab"
              aria-selected={s.id === sheet}
              className={`wb-tab${s.id === sheet ? " active" : ""}`}
              style={s.color ? { boxShadow: `inset 0 -3px 0 ${s.color}` } : undefined}
              onClick={() => s.id !== sheet && switchSheetRef.current(s.id)}
              onDoubleClick={() => !readOnly && renameSheet(s)}
              onContextMenu={(e) => { e.preventDefault(); sheetMenu(s, e.clientX, e.clientY); }}
            >
              {s.name}
            </button>
          ))}
          {!readOnly && <button className="wb-tab wb-tab-add" aria-label="Add sheet" onClick={() => mutate({ type: "AddSheet" })}>+</button>}
          {!readOnly && hiddenSheets.length > 0 && (
            <select aria-label="Unhide sheet" className="wb-select" value="" onChange={(e) => e.target.value && mutate({ type: "SetSheetHidden", sheet: Number(e.target.value), hidden: false })}>
              <option value="">Unhide…</option>
              {hiddenSheets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </div>
        {stats && stats.count > 1 && (
          <div className="wb-stats" aria-label="Selection statistics">
            Count {stats.count.toLocaleString()}
            {stats.numbers > 0 && <> · Sum {fmt(stats.sum)} · Average {fmt(stats.sum / stats.numbers)}</>}
          </div>
        )}
      </footer>

      {menu && (
        <div className="wb-menu" role="menu" style={{ left: menu.x, top: Math.max(8, menu.y) }}>
          {menu.items.map((item, i) =>
            item === "-" ? <hr key={i} /> : (
              <button key={i} role="menuitem" onClick={() => { setMenu(null); item[1](); gridRef.current?.focusCanvas(); }}>{item[0]}</button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function Tool({ label, onClick, disabled, pressed, children }: { label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; children: ReactNode }) {
  return (
    <button type="button" className={`wb-tool${pressed ? " pressed" : ""}`} title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function Sep() {
  return <span className="wb-sep" aria-hidden="true" />;
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
