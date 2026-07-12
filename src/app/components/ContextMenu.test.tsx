import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';

afterEach(cleanup);

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

  it('stays open while its own overflow is scrolled', () => {
    render(<MenuHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Show actions' }));
    const menu = screen.getByRole('menu', { name: 'Node actions' });
    fireEvent.scroll(menu);
    expect(menu).toBeVisible();
  });
});
