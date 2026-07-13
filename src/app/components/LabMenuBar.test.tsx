import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LabMenuBar, type LabMenuDefinition } from './LabMenuBar';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function menuDefinitions(): LabMenuDefinition[] {
  return [
    {
      id: 'file',
      label: 'File',
      entries: [
        { id: 'new', label: 'New lab', onSelect: vi.fn() },
        { id: 'open', label: 'Open lab', onSelect: vi.fn() },
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      entries: [{ id: 'undo', label: 'Undo', onSelect: vi.fn() }],
    },
    {
      id: 'view',
      label: 'View',
      entries: [{ id: 'zoom', label: 'Zoom to fit', onSelect: vi.fn() }],
    },
  ];
}

function renderMenuBar() {
  return render(<LabMenuBar menus={menuDefinitions()} ariaLabel="Workspace menus" />);
}

describe('LabMenuBar', () => {
  it('renders menubar semantics and anchors an opened menu below its trigger', () => {
    renderMenuBar();
    const menuBar = screen.getByRole('menubar', { name: 'Workspace menus' });
    const fileTrigger = screen.getByRole('menuitem', { name: 'File' });
    const editTrigger = screen.getByRole('menuitem', { name: 'Edit' });
    fileTrigger.getBoundingClientRect = vi.fn(() => ({
      x: 36,
      y: 12,
      top: 12,
      right: 96,
      bottom: 44,
      left: 36,
      width: 60,
      height: 32,
      toJSON: () => ({}),
    }));

    expect(menuBar).toHaveAttribute('aria-orientation', 'horizontal');
    expect(fileTrigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(fileTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(editTrigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(fileTrigger);

    const menu = screen.getByRole('menu', { name: 'File menu' });
    expect(menu).toHaveStyle({ left: '36px', top: '44px' });
    expect(fileTrigger).toHaveAttribute('aria-expanded', 'true');
    expect(editTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('menuitem', { name: 'New lab' })).toHaveFocus();
  });

  it('lets a click on the active trigger close the portaled menu', () => {
    renderMenuBar();
    const fileTrigger = screen.getByRole('menuitem', { name: 'File' });
    fireEvent.click(fileTrigger);
    expect(screen.getByRole('menu', { name: 'File menu' })).toBeVisible();

    // A real click includes pointerdown. The active trigger is excluded from
    // outside dismissal so its click handler can perform the toggle itself.
    fireEvent.pointerDown(fileTrigger);
    fireEvent.click(fileTrigger);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(fileTrigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('restores the active trigger before running a menu action', () => {
    const onSelect = vi.fn();
    render(
      <LabMenuBar menus={[{
        id: 'file',
        label: 'File',
        entries: [{ id: 'save', label: 'Save now', onSelect }],
      }]} />,
    );
    const trigger = screen.getByRole('menuitem', { name: 'File' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });

    fireEvent.click(screen.getByRole('menuitem', { name: 'Save now' }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('allows a menu action to move focus away from the restored trigger', () => {
    const targetRef = { current: null as HTMLInputElement | null };
    render(
      <>
        <LabMenuBar menus={[{
          id: 'edit',
          label: 'Edit',
          entries: [{ id: 'rename', label: 'Rename', onSelect: () => targetRef.current?.focus() }],
        }]} />
        <input ref={(element) => { targetRef.current = element; }} aria-label="Project name" />
      </>,
    );
    const trigger = screen.getByRole('menuitem', { name: 'Edit' });
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveFocus();
  });

  it('switches the open menu when another trigger is hovered', () => {
    renderMenuBar();
    const fileTrigger = screen.getByRole('menuitem', { name: 'File' });
    const editTrigger = screen.getByRole('menuitem', { name: 'Edit' });
    fireEvent.click(fileTrigger);

    fireEvent.mouseEnter(editTrigger);

    expect(screen.queryByRole('menu', { name: 'File menu' })).not.toBeInTheDocument();
    expect(screen.getByRole('menu', { name: 'Edit menu' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Undo' })).toHaveFocus();
    expect(fileTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(editTrigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('moves focus across closed-menu triggers with horizontal, Home, and End keys', () => {
    renderMenuBar();
    const fileTrigger = screen.getByRole('menuitem', { name: 'File' });
    const editTrigger = screen.getByRole('menuitem', { name: 'Edit' });
    const viewTrigger = screen.getByRole('menuitem', { name: 'View' });
    fileTrigger.focus();

    fireEvent.keyDown(fileTrigger, { key: 'ArrowRight' });
    expect(editTrigger).toHaveFocus();
    fireEvent.keyDown(editTrigger, { key: 'End' });
    expect(viewTrigger).toHaveFocus();
    fireEvent.keyDown(viewTrigger, { key: 'Home' });
    expect(fileTrigger).toHaveFocus();
    fireEvent.keyDown(fileTrigger, { key: 'ArrowLeft' });
    expect(viewTrigger).toHaveFocus();

    expect(viewTrigger).toHaveAttribute('tabindex', '0');
    expect(fileTrigger).toHaveAttribute('tabindex', '-1');
  });

  it.each([
    ['ArrowDown'],
    ['Enter'],
    [' '],
  ])('opens a trigger with the %s key', (key) => {
    renderMenuBar();
    const editTrigger = screen.getByRole('menuitem', { name: 'Edit' });
    editTrigger.focus();

    fireEvent.keyDown(editTrigger, { key });

    expect(screen.getByRole('menu', { name: 'Edit menu' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Undo' })).toHaveFocus();
  });

  it('navigates between triggers while focus is inside the portaled menu', async () => {
    renderMenuBar();
    const fileTrigger = screen.getByRole('menuitem', { name: 'File' });
    const editTrigger = screen.getByRole('menuitem', { name: 'Edit' });
    const viewTrigger = screen.getByRole('menuitem', { name: 'View' });
    fireEvent.click(editTrigger);

    fireEvent.keyDown(screen.getByRole('menu', { name: 'Edit menu' }), { key: 'ArrowRight' });
    expect(screen.getByRole('menu', { name: 'View menu' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Zoom to fit' })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('menu', { name: 'View menu' }), { key: 'Home' });
    expect(screen.getByRole('menu', { name: 'File menu' })).toBeVisible();
    fireEvent.keyDown(screen.getByRole('menu', { name: 'File menu' }), { key: 'End' });
    expect(screen.getByRole('menu', { name: 'View menu' })).toBeVisible();
    fireEvent.keyDown(screen.getByRole('menu', { name: 'View menu' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('menu', { name: 'Edit menu' })).toBeVisible();

    fireEvent.keyDown(screen.getByRole('menu', { name: 'Edit menu' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(editTrigger).toHaveFocus());
    expect(fileTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(viewTrigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes a disabled-only menu when Escape is pressed on its trigger', () => {
    render(
      <LabMenuBar
        menus={[{
          id: 'file',
          label: 'File',
          entries: [{ id: 'save', label: 'Save', disabled: true, onSelect: vi.fn() }],
        }]}
      />,
    );
    const trigger = screen.getByRole('menuitem', { name: 'File' });

    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.getByRole('menu', { name: 'File menu' })).toBeVisible();
    expect(trigger).toHaveFocus();

    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.keyDown(trigger, { key: 'Tab' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes a disabled-only compact menu when Tab leaves its trigger', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      media: '(max-width: 1150px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    render(
      <LabMenuBar menus={[{
        id: 'file',
        label: 'File',
        entries: [{ id: 'save', label: 'Save', disabled: true, onSelect: vi.fn() }],
      }]} />,
    );
    const trigger = screen.getByRole('menuitem', { name: 'Menu' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.getByRole('menu', { name: 'Application menu' })).toBeVisible();

    fireEvent.keyDown(trigger, { key: 'Tab' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('moves Tab focus relative to the trigger instead of the portaled menu', async () => {
    render(
      <>
        <a href="#before">Before</a>
        <LabMenuBar menus={menuDefinitions()} />
        <input aria-label="Project name" />
      </>,
    );
    const fileTrigger = screen.getByRole('menuitem', { name: 'File' });
    const projectName = screen.getByRole('textbox', { name: 'Project name' });
    const before = screen.getByRole('link', { name: 'Before' });

    fireEvent.keyDown(fileTrigger, { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('menu', { name: 'File menu' }), { key: 'Tab' });
    await waitFor(() => expect(projectName).toHaveFocus());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.keyDown(fileTrigger, { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('menu', { name: 'File menu' }), { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(before).toHaveFocus());
  });
});
