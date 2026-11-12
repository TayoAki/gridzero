// The code editor from DataDungeon (src/components/notebook/CodeEditor.tsx), by the same author: CodeMirror 6 with
// SQL, Python and Markdown, table and column completion, run keys, and an error-line mark. Its colours are CSS
// variables (--syn-*, --db-*), defined for GridZero in shell.css.

import { useEffect, useRef } from "react";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { Decoration, EditorView, keymap, lineNumbers, highlightActiveLineGutter, placeholder as cmPlaceholder, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent, toggleComment } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput } from "@codemirror/language";
import { sql, StandardSQL, type SQLDialect } from "@codemirror/lang-sql";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { autocompletion, closeBrackets, closeBracketsKeymap, closeCompletion, completionKeymap, completionStatus, currentCompletions } from "@codemirror/autocomplete";
import { SYNTAX_RULES } from "./syntax";

export type EditorLang = "python" | "sql" | "markdown";

/** Databricks notebook palette (research/03 §2.3) via CSS vars so light/dark both work. */
const highlight = HighlightStyle.define(SYNTAX_RULES);

const baseTheme = EditorView.theme({
  "&": {
    fontSize: "13px",
    backgroundColor: "transparent",
    color: "var(--syn-default)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    // JetBrains Mono (next/font, see src/app/layout.tsx) with ligatures off, so `>=` and `!=` look as typed.
    fontFamily: "var(--dd-font-mono)",
    fontVariantLigatures: "none",
    fontFeatureSettings: '"liga" 0, "calt" 0',
    lineHeight: "20px",
    overflow: "visible",
  },
  ".cm-content": { padding: "4px 0", caretColor: "var(--db-text)" },
  ".cm-line": { padding: "0 12px 0 4px" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--syn-linenumber)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "36px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--syn-linenumber-active)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--db-text)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "rgba(34,197,94,0.25) !important",
  },
  ".cm-placeholder": { color: "var(--db-text-placeholder)" },
  ".cm-matchingBracket": { backgroundColor: "rgba(34,197,94,0.2)", outline: "none" },
  ".cm-tooltip": {
    border: "1px solid var(--db-border)",
    backgroundColor: "var(--db-bg)",
    boxShadow: "var(--db-shadow-lg)",
    borderRadius: "4px",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--db-press)", color: "var(--db-text)" },
  ".cm-line.dd-error-line": { backgroundColor: "var(--db-error-line)" },
});

/**
 * No keyboard trap (WCAG 2.1.2): an editor reached by pressing Tab starts in CodeMirror's "Tab moves focus" mode, so
 * tabbing through the page passes over it like any other control. The first key that edits (anything but Tab,
 * Escape or a lone modifier) switches Tab back to indenting; Escape always hands focus back to the page.
 */
let tabbedIn = false;
if (typeof document !== "undefined") {
  document.addEventListener("keydown", (e) => (tabbedIn = e.key === "Tab"), true);
  document.addEventListener("pointerdown", () => (tabbedIn = false), true);
}
/**
 * A completion lookup still running when the editor loses focus (type fast, then click Run) opens its list after the
 * blur, so closeOnBlur never sees it and the list sits over the results. Close any list open in an unfocused editor.
 */
const closeCompletionWhenBlurred = EditorView.updateListener.of((u) => {
  if (u.view.hasFocus || completionStatus(u.state) === null) return;
  setTimeout(() => {
    if (!u.view.hasFocus && completionStatus(u.view.state) !== null) closeCompletion(u.view);
  }, 0);
});

/** A suggestion list is on screen (not just a source that is pending or matched nothing). */
const listShown = (v: EditorView) => currentCompletions(v.state).length > 0;

const PASS_KEYS = new Set(["Tab", "Escape", "Shift", "Control", "Alt", "Meta", "CapsLock"]);
const tabFocus = EditorView.domEventHandlers({
  focus: (_e, view) => {
    if (tabbedIn) view.setTabFocusMode(true);
  },
  keydown: (e, view) => {
    if (!PASS_KEYS.has(e.key)) view.setTabFocusMode(false);
    return false;
  },
});

function langExt(lang: EditorLang, schema?: Record<string, string[]>, dialect?: SQLDialect) {
  if (lang === "sql") return sql({ dialect: dialect ?? StandardSQL, schema, upperCaseKeywords: false });
  if (lang === "markdown") return markdown();
  return python();
}

export interface CodeEditorHandle {
  focus: () => void;
  /** The whole document and the main selection (offsets into the document). */
  getState?: () => { doc: string; from: number; to: number; head: number };
  /** Replace the main selection with `text` (inserts at the cursor when nothing is selected). */
  insertText?: (text: string) => void;
  /** Move the cursor to a 1-based line and column and focus the editor. */
  goTo?: (line: number, column?: number) => void;
}

export function CodeEditor({
  value,
  onChange,
  lang,
  lineNumbers: showLines,
  readOnly,
  placeholder,
  autoFocus,
  focusAtEnd,
  errorLine,
  onRun,
  onRunAndAdvance,
  onRunAndInsert,
  onEscape,
  onFocus,
  schema,
  onReady,
  sqlDialect,
  wrap = true,
  ariaLabel,
}: {
  value: string;
  onChange?: (v: string) => void;
  lang: EditorLang;
  lineNumbers?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** With autoFocus: put the cursor at the end (a new "%md" cell types under its magic line, not before it). */
  focusAtEnd?: boolean;
  errorLine?: number | null;
  onRun?: () => void; // Mod-Enter
  onRunAndAdvance?: () => void; // Shift-Enter
  onRunAndInsert?: () => void; // Alt-Enter
  onEscape?: () => void;
  onFocus?: () => void;
  schema?: Record<string, string[]>;
  onReady?: (h: CodeEditorHandle) => void;
  /** SQL dialect for highlighting and completion (default: standard SQL). */
  sqlDialect?: SQLDialect;
  /** Soft-wrap long lines (default on). */
  wrap?: boolean;
  /** Accessible name of the editable area. */
  ariaLabel?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment());
  const linesComp = useRef(new Compartment());
  const roComp = useRef(new Compartment());
  const errComp = useRef(new Compartment());
  const wrapComp = useRef(new Compartment());
  const cb = useRef({ onChange, onRun, onRunAndAdvance, onRunAndInsert, onEscape, onFocus });
  useEffect(() => {
    cb.current = { onChange, onRun, onRunAndAdvance, onRunAndInsert, onEscape, onFocus };
  });

  useEffect(() => {
    if (!host.current) return;
    const runKeys = Prec.highest(
      keymap.of([
        { key: "Mod-Enter", run: () => (cb.current.onRun?.(), true) },
        { key: "Shift-Enter", run: () => (cb.current.onRunAndAdvance?.(), true) },
        { key: "Alt-Enter", run: () => (cb.current.onRunAndInsert?.(), true) },
        {
          key: "Escape",
          run: (v) => {
            // Escape closes a suggestion list on screen first; only a second press leaves the editor.
            // (completionStatus alone is not enough: it stays "active" while a source's results filter down to nothing.)
            if (listShown(v)) return closeCompletion(v);
            v.contentDOM.blur();
            cb.current.onEscape?.();
            return true;
          },
        },
        {
          // Enter right after a magic command (%sql, %md, %python…) starts the next line instead of accepting a suggestion
          key: "Enter",
          run: (v) => {
            if (!listShown(v)) return false;
            const head = v.state.selection.main.head;
            const line = v.state.doc.lineAt(head);
            if (!/^\s*%\w*$/.test(line.text.slice(0, head - line.from))) return false;
            closeCompletion(v);
            return insertNewlineAndIndent(v);
          },
        },
        { key: "Mod-/", run: toggleComment },
      ]),
    );
    const state = EditorState.create({
      doc: value,
      extensions: [
        runKeys,
        tabFocus,
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ icons: false }),
        closeCompletionWhenBlurred,
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
        syntaxHighlighting(highlight),
        baseTheme,
        wrapComp.current.of(wrap ? EditorView.lineWrapping : []),
        langComp.current.of(langExt(lang, schema, sqlDialect)),
        linesComp.current.of(showLines ? [lineNumbers(), highlightActiveLineGutter()] : []),
        roComp.current.of([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly)]),
        errComp.current.of([]),
        placeholder ? cmPlaceholder(placeholder) : [],
        // Every editor has a name, and says how to leave it: Tab indents here, Escape hands focus back to the page.
        EditorView.contentAttributes.of({
          "aria-label": ariaLabel ?? `${lang === "sql" ? "SQL" : lang === "python" ? "Python" : "Markdown"} editor`,
          "aria-description": "Tab indents once you start typing. Press Escape to leave the editor.",
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cb.current.onChange?.(u.state.doc.toString());
          if (u.focusChanged && u.view.hasFocus) cb.current.onFocus?.();
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    onReady?.({
      focus: () => v.focus(),
      getState: () => {
        const r = v.state.selection.main;
        return { doc: v.state.doc.toString(), from: r.from, to: r.to, head: r.head };
      },
      insertText: (text: string) => {
        const r = v.state.selection.main;
        v.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length }, scrollIntoView: true });
        v.focus();
      },
      goTo: (line: number, column = 1) => {
        const l = v.state.doc.line(Math.max(1, Math.min(line, v.state.doc.lines)));
        const pos = Math.min(l.to, l.from + Math.max(0, column - 1));
        v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        v.focus();
      },
    });
    if (autoFocus) {
      if (focusAtEnd) v.dispatch({ selection: { anchor: v.state.doc.length } });
      v.focus();
    }
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // external value changes (reset / starter code)
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: langComp.current.reconfigure(langExt(lang, schema, sqlDialect)) });
  }, [lang, schema, sqlDialect]);

  useEffect(() => {
    view.current?.dispatch({ effects: wrapComp.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  useEffect(() => {
    view.current?.dispatch({ effects: linesComp.current.reconfigure(showLines ? [lineNumbers(), highlightActiveLineGutter()] : []) });
  }, [showLines]);

  useEffect(() => {
    view.current?.dispatch({ effects: roComp.current.reconfigure([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (!errorLine || errorLine > v.state.doc.lines) {
      v.dispatch({ effects: errComp.current.reconfigure([]) });
      return;
    }
    const line = v.state.doc.line(errorLine);
    v.dispatch({
      effects: errComp.current.reconfigure(
        EditorView.decorations.of(Decoration.set([Decoration.line({ class: "dd-error-line" }).range(line.from)])),
      ),
    });
  }, [errorLine, value]);

  return <div ref={host} className="code-editor" />;
}

