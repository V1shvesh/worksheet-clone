import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useSelector } from "react-redux";
import type { RootState } from "../../../app/store";
import type { GridInteraction } from "../interaction";
import type { GridView } from "../port";

export interface ContextMenuProps {
  view: GridView;
  controller: GridInteraction;
}

const MARGIN = 4;

/**
 * Our own context menu (the grid library never draws one). The port's `contextMenu` event opens it
 * at the pointer; the controller has already adjusted the selection by then, so the items always
 * describe what is selected. Rendered in a portal with fixed client coordinates so the overlay
 * layer's clipping and pointer-events rules do not apply to it.
 *
 * Closes on Escape, an outside press, scroll, resize, Tab, or choosing an item, and returns focus
 * to the grid.
 */
export function ContextMenu({ view, controller }: ContextMenuProps) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  // The selection and access can change while the menu is open; re-render the items from them.
  useSelector((s: RootState) => s.grid.selection);
  const menu = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);

  const close = (refocus = true) => {
    setAt(null);
    setPlaced(null);
    if (refocus) view.focus();
  };

  useEffect(() => view.on("contextMenu", (_t, x, y) => setAt({ x, y })), [view]);

  useEffect(() => {
    if (!at) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && menu.current?.contains(e.target)) return;
      // The press still reaches the grid (it selects or opens a new menu); only close ours.
      close(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    const offScroll = view.on("scroll", () => close(false));
    const onResize = () => close(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      offScroll();
    };
    // `close` only uses stable setters and `view`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, view]);

  // Keep the menu inside the viewport once its size is known, and focus the first enabled item.
  useLayoutEffect(() => {
    const el = menu.current;
    if (!at || !el) return;
    const { width, height } = el.getBoundingClientRect();
    setPlaced({
      left: Math.max(MARGIN, Math.min(at.x, window.innerWidth - width - MARGIN)),
      top: Math.max(MARGIN, Math.min(at.y, window.innerHeight - height - MARGIN)),
    });
    el.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)")?.focus();
  }, [at]);

  if (!at) return null;
  const items = controller.menuItems();

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = [...e.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']")].filter(
      (el) => !(el as HTMLButtonElement).disabled,
    );
    if (enabled.length === 0) return;
    const i = enabled.indexOf(document.activeElement as HTMLElement);
    const focus = (n: number) => enabled[(n + enabled.length) % enabled.length]!.focus();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focus(i + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focus(i < 0 ? -1 : i - 1);
        break;
      case "Home":
        e.preventDefault();
        focus(0);
        break;
      case "End":
        e.preventDefault();
        focus(-1);
        break;
      case "Tab":
        e.preventDefault();
        close();
        break;
      // Enter and Space activate the focused <button> natively (a click).
    }
  };

  return createPortal(
    <div
      ref={menu}
      className="grid-context-menu"
      data-testid="grid-context-menu"
      role="menu"
      aria-label="Grid actions"
      style={{ left: placed?.left ?? at.x, top: placed?.top ?? at.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="grid-context-menu-item"
          data-testid={item.testId}
          disabled={item.disabled}
          onClick={() => {
            controller.runMenuAction(item.action);
            close();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
