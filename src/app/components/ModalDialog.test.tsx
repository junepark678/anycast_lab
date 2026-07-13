import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModalDialog } from './ModalDialog';

afterEach(cleanup);

describe('ModalDialog', () => {
  it('portals an accessible dialog, focuses its first control, traps focus, and restores it', () => {
    const onClose = vi.fn();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const view = render(
      <ModalDialog open title="Projects" description="Manage projects" onClose={onClose}>
        <button type="button">First</button>
        <button type="button">Last</button>
      </ModalDialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Projects' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Manage projects');
    expect(screen.getByRole('button', { name: 'Close Projects' })).toHaveFocus();

    screen.getByRole('button', { name: 'Last' }).focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close Projects' })).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();

    view.rerender(
      <ModalDialog open={false} title="Projects" onClose={onClose}>
        <button type="button">First</button>
      </ModalDialog>,
    );
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('honors an explicit initial focus target', () => {
    const initialFocusRef = createRef<HTMLInputElement>();
    render(
      <ModalDialog open title="New project" onClose={vi.fn()} initialFocusRef={initialFocusRef}>
        <input ref={initialFocusRef} aria-label="Project name" />
      </ModalDialog>,
    );

    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveFocus();
  });

  it('closes from Escape and the backdrop, but blocks dismissal while busy', () => {
    const onClose = vi.fn();
    const view = render(
      <ModalDialog open title="Projects" onClose={onClose}>
        <button type="button">Action</button>
      </ModalDialog>,
    );

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);

    view.rerender(
      <ModalDialog open title="Projects" onClose={onClose} busy>
        <button type="button">Action</button>
      </ModalDialog>,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Close Projects' })).toBeDisabled();
  });
});
