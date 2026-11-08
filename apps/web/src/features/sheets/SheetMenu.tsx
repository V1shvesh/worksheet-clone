import { useEffect, useRef, type KeyboardEvent } from "react";

export interface SheetMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface SheetMenuProps {
  /** Viewport coordinates the menu opens upward from (the tab bar sits at the bottom). */
  x: number;
  y: number;
  label: string;
  items: SheetMenuItem[];
  onClose: () => void;
  testId?: string;
}

/**
 * A small popover menu: Escape or a press outside closes it, arrow keys move
 * between the enabled items. Plain React; no positioning library.
 */
export function SheetMenu({ x, y, label, items, onClose, testId }: SheetMenuProps) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [
      ...(root.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
    ];
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  }

  return (
    <div
      ref={root}
      className="sheet-menu"
      role="menu"
      aria-label={label}
      data-testid={testId}
      style={{
        left: Math.max(4, Math.min(x, window.innerWidth - 180)),
        bottom: window.innerHeight - y + 4,
      }}
      onKeyDown={onMenuKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          data-testid={`sheet-menu-${item.id}`}
          disabled={item.disabled}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
