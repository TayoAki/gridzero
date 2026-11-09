// The Python window (PRD E21, E31): a shared editor, Run, console and "Execute on wake".
// Loaded on demand: CodeMirror and Yjs are not needed until it is opened.

import { useEffect, useRef, useState } from "react";

import { python } from "@codemirror/lang-python";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { yCollab } from "y-codemirror.next";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import type { SheetSocket } from "../sheet-socket";

const Frame = { Update: 0, Awareness: 1, Snapshot: 2, Seed: 3, Compact: 4, Reset: 5 };
const REMOTE = "remote";

function tagged(tag: number, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(body.length + 1);
  out[0] = tag;
  out.set(body, 1);
  return out;
}

interface Props {
  socket: SheetSocket;
  userName: string;
  readOnly: boolean;
  onClose: () => void;
}

export function CodePanel({ socket, userName, readOnly, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<() => string>(() => "");
  const runRef = useRef<() => void>(() => {});
  const [generation, setGeneration] = useState(0);
  const [wake, setWake] = useState(true);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [functions, setFunctions] = useState<string[]>([]);

  useEffect(() => {
    let closed = false;
    socket.send({ type: "GetCode" }).then(
      (r) => {
        if (r.k === "Code" && !closed) setWake(r.execute_on_wake);
      },
      () => {},
    );
    return () => {
      closed = true;
    };
  }, [socket]);

  useEffect(() => {
    const doc = new Y.Doc();
    const text = doc.getText("code");
    const awareness = new Awareness(doc);
    awareness.setLocalStateField("user", { name: userName, color: "#1a73e8", colorLight: "#d2e3fc" });
    textRef.current = () => text.toString();

    let ws: WebSocket | null = null;
    let disposed = false;
    const send = (frame: Uint8Array<ArrayBuffer>) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
    };
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE && !readOnly) send(tagged(Frame.Update, update));
    });
    awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin !== REMOTE) send(tagged(Frame.Awareness, encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed])));
    });

    void socket.codeUrl().then((url) => {
      if (disposed) return;
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.onmessage = (ev) => {
        const frame = new Uint8Array(ev.data as ArrayBuffer);
        const body = frame.subarray(1);
        switch (frame[0]) {
          case Frame.Update:
            Y.applyUpdate(doc, body, REMOTE);
            break;
          case Frame.Awareness:
            applyAwarenessUpdate(awareness, body, REMOTE);
            break;
          case Frame.Seed:
            // Not REMOTE: this editor's insert is what everyone else receives.
            if (text.length === 0) text.insert(0, new TextDecoder().decode(body));
            break;
          case Frame.Compact:
            send(tagged(Frame.Snapshot, Y.encodeStateAsUpdate(doc)));
            break;
          case Frame.Reset:
            setGeneration((g) => g + 1);
            break;
        }
      };
    });

    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        extensions: [
          keymap.of([{ key: "Mod-Enter", run: () => (runRef.current(), true) }]),
          basicSetup,
          python(),
          yCollab(text, awareness),
          EditorState.readOnly.of(readOnly),
          EditorView.theme({ "&": { height: "100%", fontSize: "13px" }, ".cm-scroller": { overflow: "auto" } }),
        ],
      }),
    });
    return () => {
      disposed = true;
      ws?.close();
      view.destroy();
      awareness.destroy();
      doc.destroy();
    };
  }, [socket, generation, readOnly, userName]);

  async function run() {
    if (running || readOnly) return;
    setRunning(true);
    setFailure(null);
    try {
      const r = await socket.send({ type: "RunCode", source: textRef.current() });
      if (r.k === "CodeRun") {
        setOutput(r.output);
        setFailure(r.error);
        setFunctions(r.functions);
      }
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setRunning(false);
    }
  }
  runRef.current = () => void run();

  function toggleWake(on: boolean) {
    setWake(on);
    socket.send({ type: "SetExecuteOnWake", on }).catch((e: Error) => {
      setWake(!on);
      setFailure(e.message);
    });
  }

  return (
    <aside className="collab-pane code-pane" aria-label="Python code">
      <div className="dialog-head">
        <h2>Python</h2>
        <button className="link-button" onClick={onClose}>Close</button>
      </div>
      <div className="share-row">
        {!readOnly && <button className="primary share-send" disabled={running} onClick={() => void run()} title="Ctrl+Enter">{running ? "Running…" : "Run"}</button>}
        <label className="share-check">
          <input type="checkbox" checked={wake} disabled={readOnly} onChange={(e) => toggleWake(e.target.checked)} /> Execute on wake
        </label>
      </div>
      <div className="code-editor" ref={hostRef} />
      <div className="code-console" role="log" aria-label="Console">
        {functions.length > 0 && <div className="comment-meta">Usable in formulas: {functions.map((f) => `=${f}()`).join(", ")}</div>}
        {output && <pre>{output}</pre>}
        {failure && <pre className="code-error">{failure}</pre>}
        {!output && !failure && functions.length === 0 && <div className="comment-meta">Output appears here. Functions you define can be used in formulas after Run.</div>}
      </div>
    </aside>
  );
}
