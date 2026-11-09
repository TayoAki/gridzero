import { useEffect, useRef } from "react";

// Open layers, oldest first. Escape closes only the newest, so a menu over a dialog
// closes before the dialog does.
const layers: { current: () => void }[] = [];

function onKeyDown(e: KeyboardEvent) {
  // Inputs that use Escape themselves (the cell editor, Find) have already handled it.
  if (e.key !== "Escape" || e.defaultPrevented) return;
  const top = layers[layers.length - 1];
  if (!top) return;
  e.preventDefault();
  top.current();
}

/** Call `close` when Escape is pressed while this layer is the newest one open. */
export function useEscape(close: () => void, open = true) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    if (layers.length === 0) window.addEventListener("keydown", onKeyDown);
    layers.push(latest);
    return () => {
      layers.splice(layers.indexOf(latest), 1);
      if (layers.length === 0) window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
}
