import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { getSheetName, readSheetOrder, readVisibleSheetOrder } from "@worksheet-clone/shared";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useWorkbookMutations } from "../../crdt/mutations";
import { shallowEqualArrays, useDocValue, useSheetName } from "../../crdt/useDocValue";
import { useWorkbookDoc } from "../../crdt/WorkbookDoc";
import { SheetMenu, type SheetMenuItem } from "./SheetMenu";
import { SheetTab, type DropMarker } from "./SheetTab";
import { useActiveSheet } from "./useActiveSheet";
import "./SheetTabs.css";

const DRAG_THRESHOLD_PX = 5;

interface MenuState {
  kind: "tab" | "hidden";
  sheetId?: string;
  x: number;
  y: number;
}

interface DragState {
  id: string;
  pointerId: number;
  startX: number;
  active: boolean;
  cancelled: boolean;
  over: number;
}

/** The bottom tab bar: switch, add, rename, hide, delete and reorder sheets. */
export function SheetTabs() {
  const { doc, readOnly } = useWorkbookDoc();
  const canEdit = !readOnly;
  const mutations = useWorkbookMutations();
  const { sheetId: activeId, openSheet } = useActiveSheet();
  const order = useDocValue(doc, readSheetOrder, shallowEqualArrays);
  const visible = useDocValue(doc, readVisibleSheetOrder, shallowEqualArrays);
  const hidden = order.filter((id) => !visible.includes(id));

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const tabEls = useRef(new Map<string, HTMLElement>());
  const closeMenu = useCallback(() => setMenu(null), []);

  const releaseCapture = useCallback((): void => {
    const d = dragRef.current;
    if (!d) return;
    const el = tabEls.current.get(d.id);
    if (el?.hasPointerCapture?.(d.pointerId)) el.releasePointerCapture(d.pointerId);
  }, []);

  const cancelDrag = useCallback((): void => {
    const d = dragRef.current;
    if (!d) return;
    releaseCapture();
    d.cancelled = true;
    setDrag(null);
  }, [releaseCapture]);

  // A sheet that vanishes (a collaborator deleted it) closes whatever targeted it.
  useEffect(() => {
    if (renamingId && !order.includes(renamingId)) setRenamingId(null);
    if (deletingId && !order.includes(deletingId)) setDeletingId(null);
    if (menu?.sheetId && !order.includes(menu.sheetId)) setMenu(null);
  }, [order, renamingId, deletingId, menu]);

  // Read-only (e.g. access revoked mid-edit): drop every editing affordance.
  useEffect(() => {
    if (readOnly) {
      setRenamingId(null);
      setMenu(null);
      setDeletingId(null);
      cancelDrag();
    }
  }, [readOnly, cancelDrag]);

  // Escape abandons a drag in progress.
  useEffect(() => {
    if (!drag) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelDrag();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drag, cancelDrag]);

  /** Index among the visible tabs where a drop at `clientX` would insert. */
  function insertionIndex(clientX: number): number {
    let index = 0;
    for (const id of visible) {
      const rect = tabEls.current.get(id)?.getBoundingClientRect();
      if (rect && clientX > rect.left + rect.width / 2) index++;
    }
    return index;
  }

  function onPointerDown(id: string, event: PointerEvent<HTMLElement>): void {
    if (!canEdit || event.button !== 0 || renamingId) return;
    dragRef.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      active: false,
      cancelled: false,
      over: 0,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLElement>): void {
    const d = dragRef.current;
    if (!d || d.cancelled || event.pointerId !== d.pointerId) return;
    if (!d.active && Math.abs(event.clientX - d.startX) < DRAG_THRESHOLD_PX) return;
    d.active = true;
    d.over = insertionIndex(event.clientX);
    setDrag({ id: d.id, over: d.over });
  }

  function onPointerEnd(event: PointerEvent<HTMLElement>, cancelled: boolean): void {
    const d = dragRef.current;
    if (!d || event.pointerId !== d.pointerId) return;
    releaseCapture();
    dragRef.current = null;
    setDrag(null);
    if (d.active || d.cancelled) {
      // The click that follows a drag must not switch tabs.
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
    }
    if (d.active && !d.cancelled && !cancelled) drop(d.id, d.over);
  }

  /**
   * Moves `id` to the slot `over` (counted among all visible tabs, the dragged
   * one included). Hidden sheets stay where they are relative to their neighbours.
   */
  function drop(id: string, over: number): void {
    const from = visible.indexOf(id);
    if (from < 0) return;
    const slot = over - (from < over ? 1 : 0); // position among the other visible tabs
    if (slot === from) return;
    const before = visible.filter((sheetId) => sheetId !== id)[slot];
    const others = order.filter((sheetId) => sheetId !== id);
    mutations.moveSheet(id, before === undefined ? others.length : others.indexOf(before));
  }

  function consumeDragClick(): boolean {
    const was = suppressClick.current;
    suppressClick.current = false;
    return was;
  }

  function addSheet(): void {
    const id = mutations.addSheet(activeId ?? undefined);
    if (id) openSheet(id);
  }

  function move(id: string, direction: -1 | 1): void {
    const neighbour = visible[visible.indexOf(id) + direction];
    if (neighbour === undefined) return;
    // Land on the far side of the neighbouring visible tab (hidden sheets in between don't count).
    mutations.moveSheet(id, order.indexOf(neighbour));
  }

  function focusNeighbour(id: string, direction: -1 | 1): void {
    const neighbour = visible[visible.indexOf(id) + direction];
    if (neighbour === undefined) return;
    openSheet(neighbour);
    tabEls.current.get(neighbour)?.focus();
  }

  function dropMarkerFor(index: number): DropMarker {
    if (!drag) return null;
    if (drag.over === index) return "before";
    if (index === visible.length - 1 && drag.over >= visible.length) return "after";
    return null;
  }

  function menuItems(id: string): SheetMenuItem[] {
    const index = visible.indexOf(id);
    const onlyVisible = visible.length <= 1;
    return [
      { id: "rename", label: "Rename", onSelect: () => setRenamingId(id) },
      {
        id: "hide",
        label: "Hide",
        disabled: onlyVisible,
        onSelect: () => mutations.setSheetHidden(id, true),
      },
      { id: "move-left", label: "Move left", disabled: index <= 0, onSelect: () => move(id, -1) },
      {
        id: "move-right",
        label: "Move right",
        disabled: index < 0 || index >= visible.length - 1,
        onSelect: () => move(id, 1),
      },
      {
        id: "delete",
        label: "Delete",
        disabled: onlyVisible,
        onSelect: () => setDeletingId(id),
      },
    ];
  }

  if (visible.length === 0) return null;

  return (
    <div className="sheet-tabs">
      {canEdit && (
        <button
          type="button"
          className="sheet-tabs-button"
          data-testid="add-sheet"
          aria-label="Add sheet"
          title="Add sheet"
          onClick={addSheet}
        >
          +
        </button>
      )}
      {canEdit && hidden.length > 0 && (
        <button
          type="button"
          className="sheet-tabs-button"
          data-testid="hidden-sheets"
          aria-haspopup="menu"
          title="Hidden sheets"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ kind: "hidden", x: rect.left, y: rect.top });
          }}
        >
          Hidden ({hidden.length})
        </button>
      )}
      <div role="tablist" aria-label="Sheets" className="sheet-tabs-list">
        {visible.map((id, index) => (
          <div key={id} className="sheet-tab-wrap" role="presentation">
            <SheetTab
              sheetId={id}
              selected={id === activeId}
              canEdit={canEdit}
              renaming={renamingId === id}
              dropMarker={dropMarkerFor(index)}
              dragging={drag?.id === id}
              registerEl={(el) => {
                if (el) tabEls.current.set(id, el);
                else tabEls.current.delete(id);
              }}
              onOpen={() => openSheet(id)}
              onStartRename={() => setRenamingId(id)}
              onEndRename={() => setRenamingId((current) => (current === id ? null : current))}
              rename={(name) => mutations.renameSheet(id, name)}
              onMenu={(x, y) => setMenu({ kind: "tab", sheetId: id, x, y })}
              onArrow={(direction) => focusNeighbour(id, direction)}
              onPointerDown={(event) => onPointerDown(id, event)}
              onPointerMove={onPointerMove}
              onPointerEnd={onPointerEnd}
              consumeDragClick={consumeDragClick}
            />
            {canEdit && id === activeId && renamingId !== id && (
              <button
                type="button"
                className="sheet-tab-menu-button"
                data-testid="sheet-tab-menu"
                aria-label="Sheet menu"
                aria-haspopup="menu"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenu({ kind: "tab", sheetId: id, x: rect.left, y: rect.top });
                }}
              >
                ▾
              </button>
            )}
          </div>
        ))}
      </div>
      {menu?.kind === "tab" && menu.sheetId && (
        <SheetMenu
          x={menu.x}
          y={menu.y}
          label="Sheet actions"
          testId="sheet-menu"
          items={menuItems(menu.sheetId)}
          onClose={closeMenu}
        />
      )}
      {menu?.kind === "hidden" && (
        <HiddenSheetsMenu
          x={menu.x}
          y={menu.y}
          hidden={hidden}
          onChoose={(id) => {
            mutations.setSheetHidden(id, false);
            openSheet(id);
          }}
          onClose={closeMenu}
        />
      )}
      {deletingId && (
        <DeleteSheetDialog
          sheetId={deletingId}
          onCancel={() => setDeletingId(null)}
          onConfirm={() => {
            mutations.deleteSheet(deletingId);
            setDeletingId(null);
          }}
        />
      )}
    </div>
  );
}

function DeleteSheetDialog({
  sheetId,
  onConfirm,
  onCancel,
}: {
  sheetId: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const name = useSheetName(sheetId) ?? "this sheet";
  return (
    <ConfirmDialog
      title="Delete sheet"
      message={`Delete "${name}" and everything in it? Formulas that reference it will show #REF!.`}
      confirmLabel="Delete sheet"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

function HiddenSheetsMenu({
  x,
  y,
  hidden,
  onChoose,
  onClose,
}: {
  x: number;
  y: number;
  hidden: string[];
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  const { doc } = useWorkbookDoc();
  const names = useDocValue(
    doc,
    (d) => hidden.map((id) => getSheetName(d, id) ?? id),
    shallowEqualArrays,
  );
  const items: SheetMenuItem[] = hidden.map((id, i) => ({
    id: `unhide-${id}`,
    label: names[i] ?? id,
    onSelect: () => onChoose(id),
  }));
  return (
    <SheetMenu
      x={x}
      y={y}
      label="Hidden sheets"
      testId="hidden-sheets-menu"
      items={items}
      onClose={onClose}
    />
  );
}
