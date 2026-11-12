// Any screen can open the panel for a thing: openPanel({ kind, id, label }). The shell holds the one host.

import { useEffect, useState } from "react";

import { ObjectPanel } from "./ObjectPanel";
import type { ObjectRef } from "./ObjectPanel";

let listener: ((item: ObjectRef | null) => void) | null = null;
export const openPanel = (item: ObjectRef) => listener?.(item);

export function PanelHost() {
  const [item, setItem] = useState<ObjectRef | null>(null);
  useEffect(() => {
    listener = setItem;
    return () => {
      listener = null;
    };
  }, []);
  return item ? <ObjectPanel key={item.kind + item.id} item={item} onClose={() => setItem(null)} /> : null;
}
