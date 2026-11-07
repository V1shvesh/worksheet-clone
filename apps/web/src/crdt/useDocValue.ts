import { useCallback, useRef, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { getSheetName, readSheetOrder } from "@worksheet-clone/shared";
import { useWorkbookDoc } from "./WorkbookDoc";

export function shallowEqualArrays<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
}

/**
 * Subscribes a component to a value derived from the doc. Re-renders only
 * when `isEqual` says the derived value changed, so readers returning fresh
 * arrays don't re-render on every remote update.
 *
 * Listens to whole-doc updates for now; M4a narrows grid reads to per-key
 * observers.
 */
export function useDocValue<T>(
  doc: Y.Doc,
  read: (doc: Y.Doc) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const cache = useRef<{ value: T } | null>(null);

  const getSnapshot = (): T => {
    const next = read(doc);
    if (cache.current && isEqual(cache.current.value, next)) {
      return cache.current.value;
    }
    cache.current = { value: next };
    return next;
  };

  const subscribe = useCallback(
    (onChange: () => void) => {
      doc.on("update", onChange);
      return () => doc.off("update", onChange);
    },
    [doc],
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useSheetOrder(): string[] {
  const { doc } = useWorkbookDoc();
  return useDocValue(doc, readSheetOrder, shallowEqualArrays);
}

export function useSheetName(sheetId: string): string | undefined {
  const { doc } = useWorkbookDoc();
  return useDocValue(doc, (d) => getSheetName(d, sheetId));
}
