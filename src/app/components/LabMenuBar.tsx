import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';

export interface LabMenuDefinition {
  id: string;
  label: string;
  entries: ContextMenuEntry[];
}

export interface LabMenuBarProps {
  menus: LabMenuDefinition[];
  ariaLabel?: string;
  className?: string;
}

const HORIZONTAL_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
const COMPACT_MENU_QUERY = '(max-width: 1150px)';
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function adjacentIndex(key: string, currentIndex: number, menuCount: number): number {
  if (key === 'Home') return 0;
  if (key === 'End') return menuCount - 1;
  if (key === 'ArrowRight') return (currentIndex + 1) % menuCount;
  return (currentIndex - 1 + menuCount) % menuCount;
}

export function LabMenuBar({ menus, ariaLabel = 'Lab menu', className }: LabMenuBarProps) {
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const triggerRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeAnchorRef = useRef<HTMLElement | null>(null);
  const [compactLayout, setCompactLayout] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(COMPACT_MENU_QUERY).matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia?.(COMPACT_MENU_QUERY);
    if (!mediaQuery) return;
    const updateLayout = () => setCompactLayout(mediaQuery.matches);
    updateLayout();
    mediaQuery.addEventListener('change', updateLayout);
    return () => mediaQuery.removeEventListener('change', updateLayout);
  }, []);

  useEffect(() => {
    setActiveMenuId(null);
  }, [compactLayout]);

  const openMenu = useCallback((index: number) => {
    const menu = menus[index];
    const trigger = triggerRefs.current[index];
    if (!menu || !trigger) return;

    const bounds = trigger.getBoundingClientRect();
    activeAnchorRef.current = trigger;
    setFocusedIndex(index);
    setPosition({ x: bounds.left, y: bounds.bottom });
    setActiveMenuId(menu.id);
  }, [menus]);

  useEffect(() => {
    if (activeMenuId !== null && activeMenuId !== 'compact' && !menus.some((menu) => menu.id === activeMenuId)) {
      setActiveMenuId(null);
    }
    setFocusedIndex((current) => Math.min(current, Math.max(0, menus.length - 1)));
  }, [activeMenuId, menus]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (menus.length === 0) return;

    if (event.key === 'Tab' && activeMenuId !== null) {
      setActiveMenuId(null);
      return;
    }

    if (HORIZONTAL_KEYS.includes(event.key)) {
      event.preventDefault();
      const nextIndex = adjacentIndex(event.key, index, menus.length);
      if (activeMenuId !== null) {
        openMenu(nextIndex);
      } else {
        setFocusedIndex(nextIndex);
        triggerRefs.current[nextIndex]?.focus();
      }
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      openMenu(index);
      return;
    }

    if (event.key === 'Escape' && activeMenuId !== null) {
      event.preventDefault();
      setActiveMenuId(null);
    }
  };

  const handleOpenMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      moveFocusFromTrigger(event.shiftKey);
      return;
    }
    if (!HORIZONTAL_KEYS.includes(event.key) || menus.length === 0) return;

    const currentIndex = menus.findIndex((menu) => menu.id === activeMenuId);
    if (currentIndex < 0) return;
    event.preventDefault();
    event.stopPropagation();
    openMenu(adjacentIndex(event.key, currentIndex, menus.length));
  };

  const activeMenu = menus.find((menu) => menu.id === activeMenuId);
  const compactEntries: ContextMenuEntry[] = menus.flatMap((menu, index) => [
    ...(index === 0 ? [] : [{ type: 'separator' as const, id: `compact-${menu.id}-separator` }]),
    ...menu.entries.map((entry) => entry.type === 'separator'
      ? { ...entry, id: `compact-${menu.id}-${entry.id}` }
      : { ...entry, id: `compact-${menu.id}-${entry.id}`, label: `${menu.label}: ${entry.label}` }),
  ]);
  const isCompactMenuOpen = activeMenuId === 'compact';
  const displayedMenu = isCompactMenuOpen
    ? { id: 'compact', label: 'Application', entries: compactEntries }
    : activeMenu;
  const menuBarClassName = className ? `lab-menu-bar ${className}` : 'lab-menu-bar';

  const moveFocusFromTrigger = (backward: boolean) => {
    const trigger = activeAnchorRef.current;
    if (!trigger) return;

    const focusable = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => element.tabIndex >= 0 && !element.hasAttribute('hidden'));
    const triggerIndex = focusable.indexOf(trigger);
    const target = focusable[triggerIndex + (backward ? -1 : 1)];
    setActiveMenuId(null);
    if (target) queueMicrotask(() => target.focus());
  };

  const openCompactMenu = () => {
    const trigger = triggerRefs.current[menus.length];
    if (!trigger) return;
    const bounds = trigger.getBoundingClientRect();
    activeAnchorRef.current = trigger;
    setPosition({ x: bounds.left, y: bounds.bottom });
    setActiveMenuId('compact');
  };

  return (
    <div className={menuBarClassName} role="menubar" aria-label={ariaLabel} aria-orientation="horizontal">
      {compactLayout ? (
        <button
          ref={(element) => { triggerRefs.current[menus.length] = element; }}
          type="button"
          role="menuitem"
          className={`lab-menu-bar__trigger lab-menu-bar__trigger--compact${isCompactMenuOpen ? ' is-active' : ''}`}
          aria-haspopup="menu"
          aria-expanded={isCompactMenuOpen}
          onClick={() => {
            if (isCompactMenuOpen) {
              setActiveMenuId(null);
              return;
            }
            openCompactMenu();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Tab' && isCompactMenuOpen) {
              setActiveMenuId(null);
              return;
            }
            if (event.key === 'Escape' && isCompactMenuOpen) {
              event.preventDefault();
              setActiveMenuId(null);
              return;
            }
            if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
              event.preventDefault();
              openCompactMenu();
            }
          }}
        >
          Menu
        </button>
      ) : (
        <div className="lab-menu-bar__desktop">
          {menus.map((menu, index) => (
            <button
              key={menu.id}
              ref={(element) => { triggerRefs.current[index] = element; }}
              type="button"
              role="menuitem"
              className={`lab-menu-bar__trigger${activeMenuId === menu.id ? ' is-active' : ''}`}
              aria-haspopup="menu"
              aria-expanded={activeMenuId === menu.id}
              tabIndex={focusedIndex === index ? 0 : -1}
              onFocus={() => setFocusedIndex(index)}
              onClick={() => {
                if (activeMenuId === menu.id) {
                  setActiveMenuId(null);
                  return;
                }
                openMenu(index);
              }}
              onMouseEnter={() => {
                if (activeMenuId !== null && activeMenuId !== menu.id) openMenu(index);
              }}
              onKeyDown={(event) => handleTriggerKeyDown(event, index)}
            >
              {menu.label}
            </button>
          ))}
        </div>
      )}
      {displayedMenu && (
        <ContextMenu
          key={displayedMenu.id}
          ariaLabel={`${displayedMenu.label} menu`}
          entries={displayedMenu.entries}
          position={position}
          anchorRef={activeAnchorRef}
          onKeyDown={handleOpenMenuKeyDown}
          onClose={() => setActiveMenuId(null)}
        />
      )}
    </div>
  );
}
