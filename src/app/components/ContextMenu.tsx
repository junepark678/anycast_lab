import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuAction {
  type?: 'action';
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  tone?: 'default' | 'danger';
  onSelect: () => void;
}

export interface ContextMenuSeparator {
  type: 'separator';
  id: string;
}

export type ContextMenuEntry = ContextMenuAction | ContextMenuSeparator;

interface Props {
  ariaLabel: string;
  entries: ContextMenuEntry[];
  position: { x: number; y: number };
  onClose: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}

const VIEWPORT_MARGIN = 8;

function isAction(entry: ContextMenuEntry): entry is ContextMenuAction {
  return entry.type !== 'separator';
}

/**
 * A small portal-based menu shared by the topology interaction surfaces.
 * It intentionally owns dismissal, viewport clamping, and roving focus so
 * callers only need to describe actions and their anchor point.
 */
export function ContextMenu({ ariaLabel, entries, position, onClose, anchorRef, onKeyDown }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    anchorRef?.current ?? (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null),
  );
  const [placedAt, setPlacedAt] = useState(position);

  const close = useCallback((restoreFocus = false) => {
    const returnTarget = restoreFocus ? returnFocusRef.current : null;
    if (returnTarget) returnTarget.focus();
    onClose();
  }, [onClose]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - bounds.width - VIEWPORT_MARGIN);
    const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - bounds.height - VIEWPORT_MARGIN);
    setPlacedAt({
      x: Math.min(Math.max(position.x, VIEWPORT_MARGIN), maxX),
      y: Math.min(Math.max(position.y, VIEWPORT_MARGIN), maxY),
    });
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [position.x, position.y]);

  useEffect(() => {
    const dismissFromOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !anchorRef?.current?.contains(target)) close();
    };
    const dismissFromViewportChange = (event: Event) => {
      if (event.type === 'scroll' && event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      close();
    };
    const dismissFromOutsideScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', dismissFromOutside, true);
    window.addEventListener('blur', dismissFromViewportChange);
    window.addEventListener('resize', dismissFromViewportChange);
    window.addEventListener('scroll', dismissFromOutsideScroll, true);
    return () => {
      document.removeEventListener('pointerdown', dismissFromOutside, true);
      window.removeEventListener('blur', dismissFromViewportChange);
      window.removeEventListener('resize', dismissFromViewportChange);
      window.removeEventListener('scroll', dismissFromOutsideScroll, true);
    };
  }, [anchorRef, close]);

  const enabledItems = () => Array.from(
    menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const items = enabledItems();
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || items.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={ariaLabel}
      style={{ left: placedAt.x, top: placedAt.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
    >
      {entries.map((entry) => {
        if (!isAction(entry)) {
          return <div className="context-menu__separator" role="separator" key={entry.id} />;
        }
        return (
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`context-menu__item${entry.tone === 'danger' ? ' context-menu__item--danger' : ''}`}
            disabled={entry.disabled}
            key={entry.id}
            onClick={() => {
              if (entry.disabled) return;
              close(true);
              entry.onSelect();
            }}
          >
            <span className="context-menu__icon" aria-hidden="true">{entry.icon}</span>
            <span className="context-menu__label">{entry.label}</span>
            {entry.shortcut && <kbd className="context-menu__shortcut" aria-hidden="true">{entry.shortcut}</kbd>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
