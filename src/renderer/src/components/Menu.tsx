import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { create } from 'zustand';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  onSelect: () => void;
}

/** A menu is a list of items, with `null` for a divider and a plain string for a section label. */
export type MenuEntry = MenuItem | null | string | false | undefined;

interface OpenMenu {
  entries: MenuEntry[];
  /** Point (for context menus) or box (for buttons) the menu is attached to. */
  anchor: { x: number; y: number; width: number; height: number };
  align: 'start' | 'end';
}

const useMenu = create<{ open: OpenMenu | null }>(() => ({ open: null }));

export function closeMenu(): void {
  useMenu.setState({ open: null });
}

/** Opens a menu at the pointer, for right-clicks. */
export function openContextMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, entries: MenuEntry[]): void {
  e.preventDefault();
  e.stopPropagation();
  useMenu.setState({ open: { entries, anchor: { x: e.clientX, y: e.clientY, width: 0, height: 0 }, align: 'start' } });
}

/** Opens a menu below an element, for menu buttons. */
export function openMenuAt(el: Element, entries: MenuEntry[], align: 'start' | 'end' = 'start'): void {
  const r = el.getBoundingClientRect();
  useMenu.setState({ open: { entries, anchor: { x: r.left, y: r.top, width: r.width, height: r.height }, align } });
}

/** Wraps any trigger so that clicking it opens a menu. */
export function MenuButton(props: { entries: () => MenuEntry[]; align?: 'start' | 'end'; children: (open: (e: ReactMouseEvent) => void) => ReactNode }): ReactNode {
  return props.children((e) => {
    e.stopPropagation();
    openMenuAt(e.currentTarget as Element, props.entries(), props.align);
  });
}

export function MenuHost(): ReactNode {
  const open = useMenu((s) => s.open);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) {
      setPos(null);
      return;
    }
    const { width, height } = ref.current.getBoundingClientRect();
    const a = open.anchor;
    const isPoint = a.width === 0 && a.height === 0;
    let left = open.align === 'end' ? a.x + a.width - width : a.x;
    let top = isPoint ? a.y : a.y + a.height + 4;
    // Flip above the trigger when there is no room below, and keep inside the window.
    if (top + height > window.innerHeight - 8) top = isPoint ? a.y - height : a.y - height - 4;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    setPos({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeMenu();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)') ?? [])];
        if (!items.length) return;
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[next].focus();
      }
    };
    // Capture phase so the menu closes even when the click lands on something that stops propagation.
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('resize', closeMenu);
    };
  }, [open]);

  if (!open) return null;
  const entries = open.entries.filter((e) => e !== false && e !== undefined);
  return createPortal(
    <div ref={ref} className="menu" role="menu" style={pos ? pos : { left: 0, top: 0, visibility: 'hidden' }} onContextMenu={(e) => e.preventDefault()}>
      {entries.map((entry, i) => {
        if (entry === null) return <div key={i} className="menu-sep" role="separator" />;
        if (typeof entry === 'string') {
          return (
            <div key={i} className="menu-label">
              {entry}
            </div>
          );
        }
        const item = entry as MenuItem;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`menu-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              closeMenu();
              item.onSelect();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.hint && <span className="hint">{item.hint}</span>}
            {item.checked && <Check size={14} className="check" />}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
