export interface ResolveActiveSheetInput {
  /** The `sheet` URL parameter, if any. */
  requested: string | null;
  /** Every existing sheet id in tab order, hidden ones included. */
  order: readonly string[];
  /** The sheets that have a tab, in order (never empty once the doc has synced). */
  visible: readonly string[];
  /** The sheet this client showed last, with its position then. */
  last: { id: string; index: number } | null;
}

export interface ResolvedSheet {
  sheetId: string;
  /** The URL does not say this sheet yet and should be replaced to do so. */
  replaceUrl: boolean;
}

/**
 * Which sheet to show. The URL wins when it names a visible sheet. When the
 * sheet being shown disappears (a collaborator deleted or hid it), the visible
 * sheet nearest to its former position takes over (the right one on a tie, as
 * Excel does); any other unusable value falls back to the first visible sheet.
 * Returns null before the document has any sheet.
 */
export function resolveActiveSheet(input: ResolveActiveSheetInput): ResolvedSheet | null {
  const { requested, order, visible, last } = input;
  const [first] = visible;
  if (first === undefined) return null;
  if (requested !== null && visible.includes(requested)) {
    return { sheetId: requested, replaceUrl: false };
  }
  if (requested !== null && last?.id === requested) {
    let best = first;
    let bestDistance = Infinity;
    for (const id of visible) {
      const distance = Math.abs(order.indexOf(id) - last.index);
      // `<=` so that on a tie the later (right-hand) sheet wins.
      if (distance <= bestDistance) {
        best = id;
        bestDistance = distance;
      }
    }
    return { sheetId: best, replaceUrl: true };
  }
  return { sheetId: first, replaceUrl: true };
}
