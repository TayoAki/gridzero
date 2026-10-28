import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Link, useParams } from "react-router";

import { CanvasGrid, columnName } from "../grid/grid";
import type { CellPos } from "../grid/grid";
import { TileCache } from "../grid/tiles";
import { SheetSocket } from "../sheet-socket";
import type { Grant } from "../sheet-socket";

// Excel's sheet limits; the server enforces the same bounds.
const ROWS = 1_048_576;
const COLS = 16_384;
const SHEET = 0;

interface Editor {
  value: string;
  // Where the edit started, so a click elsewhere commits to the right cell.
  pos: CellPos;
  // Which input owns keyboard focus; the other one mirrors the value.
  via: "cell" | "bar";
}

export function WorkbookPage() {
  const { id = "" } = useParams();
  const hostRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<CanvasGrid | null>(null);
  const socketRef = useRef<SheetSocket | null>(null);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<CellPos>({ row: 0, col: 0 });
  const [formula, setFormula] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  // Latest editor state for grid callbacks that were bound once.
  const editorState = useRef<Editor | null>(null);
  editorState.current = editor;

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
        requestTiles(tiles) {
          const gen = cache.generation;
          socket.send({ type: "GetTiles", sheet: SHEET, tiles }).then(
            (m) => m.t === "Tiles" && cache.receive(m.tiles, gen),
            () => {},
          );
        },
      },
      () => grid.invalidate(),
    );
    const grid = new CanvasGrid(host, cache, { rows: ROWS, cols: COLS, frozenRows: 0, frozenCols: 0 });

    const loadFormula = (pos: CellPos) =>
      socket.send({ type: "GetCell", sheet: SHEET, row: pos.row, col: pos.col }).then(
        (m) => m.t === "Cell" && m.row === grid.focus.row && m.col === grid.focus.col && setFormula(m.raw),
        () => {},
      );

    socket.onStatus = (s) => {
      setStatus(s);
      // Requests made while disconnected were dropped; re-request everything visible.
      if (s === "open") cache.invalidate();
    };
    socket.onWelcome = () => loadFormula(grid.focus);
    socket.onChanged = () => {
      cache.invalidate();
      loadFormula(grid.focus);
    };
    grid.onSelect = (pos) => {
      setFocus(pos);
      loadFormula(pos);
    };
    grid.onEditRequest = (initial) => {
      // Fast typing can deliver more text to the grid before the editor takes focus; append it.
      if (editorState.current && initial !== undefined) {
        setEditor((e) => (e ? { ...e, value: e.value + initial } : e));
        return;
      }
      const pos = { ...grid.focus };
      setEditor({ value: initial ?? "", pos, via: "cell" });
      if (initial === undefined) {
        // F2 / double-click edits the existing contents.
        socket.send({ type: "GetCell", sheet: SHEET, row: pos.row, col: pos.col }).then(
          (m) => m.t === "Cell" && setEditor((e) => (e && e.pos.row === m.row && e.pos.col === m.col ? { ...e, value: m.raw } : e)),
          () => {},
        );
      }
    };
    grid.onClear = () => commit({ value: "", pos: { ...grid.focus }, via: "cell" });

    gridRef.current = grid;
    socketRef.current = socket;
    grid.focusCanvas();
    return () => {
      socket.close();
      grid.destroy();
    };
  }, [id]);

  useEffect(() => {
    if (editor?.via === "cell") editorRef.current?.focus();
  }, [editor === null, editor?.via]);

  function commit(edit: Editor) {
    const socket = socketRef.current;
    if (!socket) return;
    socket
      .send({ type: "UpdateCell", sheet: SHEET, row: edit.pos.row, col: edit.pos.col, raw: edit.value })
      .catch((e: Error) => setError(e.message));
  }

  function finishEdit(dRow: number, dCol: number) {
    const current = editorState.current;
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
      setEditor(null);
      gridRef.current?.focusCanvas();
    }
  }

  async function saveTitle(next: string) {
    const trimmed = next.trim();
    if (!trimmed) return;
    const res = await fetch(`/api/v1/workbooks/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: trimmed }),
    });
    if (res.ok) setTitle(trimmed);
  }

  const rect = editor && gridRef.current?.visibleCellRect(editor.pos.row, editor.pos.col);

  return (
    <div className="workbook">
      <header className="wb-header">
        <Link to="/" className="wb-home" aria-label="Back to home">GridZero</Link>
        <input
          className="wb-title"
          aria-label="Workbook title"
          defaultValue={title}
          key={title}
          onBlur={(e) => void saveTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <span className={`wb-status wb-status-${status}`}>{status === "open" ? "Saved" : status === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
      </header>
      {error && <p className="wb-error" role="alert">{error}</p>}
      <div className="wb-formula-bar">
        <span className="wb-namebox" aria-label="Selected cell">{columnName(focus.col)}{focus.row + 1}</span>
        <input
          className="wb-formula"
          aria-label="Formula bar"
          value={editor ? editor.value : formula}
          onFocus={() => setEditor((ed) => (ed ? { ...ed, via: "bar" } : { value: formula, pos: { ...focus }, via: "bar" }))}
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
    </div>
  );
}
