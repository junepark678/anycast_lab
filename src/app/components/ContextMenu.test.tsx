import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';

afterEach(cleanup);

afterEach(() => {
  vi.restoreAllMocks();
});

function MenuHarness({ onSelect = vi.fn() }: { onSelect?: () => void }) {
  const [open, setOpen] = useState(false);
  const entries: ContextMenuEntry[] = [
    { id: 'open', label: 'Open console', onSelect },
    { id: 'disabled', label: 'Unavailable action', disabled: true, onSelect: vi.fn() },
    { type: 'separator', id: 'separator' },
    { id: 'delete', label: 'Delete node', tone: 'danger', onSelect: vi.fn() },
  ];
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Show actions</button>
      {open && (
        <ContextMenu
          ariaLabel="Node actions"
          entries={entries}
          position={{ x: 20, y: 30 }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

describe('ContextMenu', () => {
  it('uses menu semantics and moves focus among enabled actions', () => {
    render(<MenuHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Show actions' }));

    const menu = screen.getByRole('menu', { name: 'Node actions' });
    expect(screen.getByRole('menuitem', { name: 'Open console' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Unavailable action' })).toBeDisabled();

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Delete node' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(screen.getByRole('menuitem', { name: 'Open console' })).toHaveFocus();
  });

  it('wraps keyboard navigation in both directions and supports End', () => {
    render(<MenuHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Show actions' }));

    const menu = screen.getByRole('menu', { name: 'Node actions' });
    const first = screen.getByRole('menuitem', { name: 'Open console' });
    const last = screen.getByRole('menuitem', { name: 'Delete node' });

    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(last).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(last).toHaveFocus();
  });

  it('runs an action and dismisses the menu', () => {
    const onSelect = vi.fn();
    render(<MenuHarness onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open console' }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('dismisses on Escape and restores focus to the invoking control', async () => {
    render(<MenuHarness />);
    const trigger = screen.getByRole('button', { name: 'Show actions' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('dismisses when the user presses outside it', () => {
    render(<MenuHarness />);
    const trigger = screen.getByRole('button', { name: 'Show actions' });
    fireEvent.click(trigger);
    fireEvent.pointerDown(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('dismisses on Tab and viewport changes', () => {
    render(<MenuHarness />);
    const trigger = screen.getByRole('button', { name: 'Show actions' });

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent(window, new Event('resize'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent(window, new Event('blur'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('clamps its placement to all viewport margins', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 240,
      bottom: 180,
      left: 0,
      width: 240,
      height: 180,
      toJSON: () => ({}),
    });
    const entries: ContextMenuEntry[] = [{ id: 'one', label: 'One', onSelect: vi.fn() }];
    const { rerender } = render(
      <ContextMenu
        ariaLabel="Clamped actions"
        entries={entries}
        position={{ x: -100, y: -100 }}
        onClose={vi.fn()}
      />,
    );

    const menu = screen.getByRole('menu', { name: 'Clamped actions' });
    expect(menu).toHaveStyle({ left: '8px', top: '8px' });

    rerender(
      <ContextMenu
        ariaLabel="Clamped actions"
        entries={entries}
        position={{ x: window.innerWidth + 100, y: window.innerHeight + 100 }}
        onClose={vi.fn()}
      />,
    );
    expect(menu).toHaveStyle({
      left: `${Math.max(8, window.innerWidth - 248)}px`,
      top: `${Math.max(8, window.innerHeight - 188)}px`,
    });
  });

  it('stays open while its own overflow is scrolled', () => {
    render(<MenuHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Show actions' }));
    const menu = screen.getByRole('menu', { name: 'Node actions' });
    fireEvent.scroll(menu);
    expect(menu).toBeVisible();
  });

  it('dismisses when scrolling occurs outside the menu', () => {
    render(<MenuHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Show actions' }));
    fireEvent.scroll(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
