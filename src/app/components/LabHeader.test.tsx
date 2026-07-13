import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LabHeader } from './LabHeader';

afterEach(cleanup);

function renderHeader(
  persistenceReady: boolean,
  callbacks: {
    onProjectNameChange?: ReturnType<typeof vi.fn>;
    onManageProjects?: ReturnType<typeof vi.fn>;
    onSave?: ReturnType<typeof vi.fn>;
    onDeleteSelection?: ReturnType<typeof vi.fn>;
    onTogglePalette?: ReturnType<typeof vi.fn>;
  } = {},
  options: { selectionType?: 'node' | 'link' | null; paletteCollapsed?: boolean } = {},
) {
  const noop = vi.fn();
  return render(<LabHeader
    projectName="Test lab"
    running={false}
    runtimeBusy={false}
    projectMutationLocked={false}
    persistenceReady={persistenceReady}
    dirty={false}
    saveState="saved"
    runtimeMode="simulation"
    nativeRuntimeState="unavailable"
    nativeRuntimeDetail="Unavailable"
    fileInputRef={createRef<HTMLInputElement>()}
    onProjectNameChange={callbacks.onProjectNameChange ?? noop}
    onManageProjects={callbacks.onManageProjects ?? noop}
    onRuntimeModeChange={noop}
    onRunToggle={noop}
    onReset={noop}
    onSave={callbacks.onSave ?? noop}
    onExport={noop}
    onImport={noop}
    selectionType={options.selectionType ?? null}
    paletteCollapsed={options.paletteCollapsed ?? false}
    detailsCollapsed={false}
    onDeleteSelection={callbacks.onDeleteSelection ?? noop}
    onTogglePalette={callbacks.onTogglePalette ?? noop}
    onToggleDetails={noop}
    onResetWorkspace={noop}
  />);
}

describe('LabHeader persistence readiness', () => {
  it('keeps save and import disabled until startup restoration has settled', () => {
    const view = renderHeader(false);

    expect(screen.getAllByTitle('Preparing local storage…')).toHaveLength(3);
    for (const control of screen.getAllByTitle('Preparing local storage…')) {
      expect(control).toBeDisabled();
    }

    view.unmount();
    renderHeader(true);
    expect(screen.getByTitle('Save now')).toBeEnabled();
    expect(screen.getByTitle('Import project')).toBeEnabled();
  });

  it('commits trimmed names and rejects transient blank drafts', () => {
    const rename = vi.fn();
    renderHeader(true, { onProjectNameChange: rename });
    const input = screen.getByRole('textbox', { name: 'Project name' });

    fireEvent.change(input, { target: { value: '   ' } });
    expect(rename).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(rename).not.toHaveBeenCalled();
    expect(input).toHaveValue('Test lab');

    fireEvent.change(input, { target: { value: '  Production lab  ' } });
    expect(rename).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(rename).toHaveBeenCalledWith('Production lab');

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Temporary name' } });
    expect(rename).toHaveBeenCalledWith('Temporary name');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(rename).toHaveBeenLastCalledWith('Test lab');
    expect(input).toHaveValue('Test lab');
  });

  it('opens project management from the persistent header control', () => {
    const manage = vi.fn();
    renderHeader(true, { onManageProjects: manage });

    fireEvent.click(screen.getByRole('button', { name: 'Manage projects' }));
    expect(manage).toHaveBeenCalledOnce();
  });

  it('exposes desktop-style application menus and routes file actions', () => {
    const save = vi.fn();
    renderHeader(true, { onSave: save });

    const menuBar = screen.getByRole('menubar', { name: 'Application menu' });
    expect(within(menuBar).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'File',
      'Edit',
      'View',
      'Run',
      'Help',
    ]);

    fireEvent.click(within(menuBar).getByRole('menuitem', { name: 'File' }));
    const fileMenu = screen.getByRole('menu', { name: 'File menu' });
    fireEvent.click(within(fileMenu).getByRole('menuitem', { name: 'Save now' }));
    expect(save).toHaveBeenCalledOnce();
  });

  it('maps edit and view menu actions to the active workspace state', () => {
    const deleteSelection = vi.fn();
    const togglePalette = vi.fn();
    renderHeader(true, { onDeleteSelection: deleteSelection, onTogglePalette: togglePalette }, {
      selectionType: 'node',
      paletteCollapsed: true,
    });

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete selected node' }));
    expect(deleteSelection).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show appliance palette' }));
    expect(togglePalette).toHaveBeenCalledOnce();
  });
});
