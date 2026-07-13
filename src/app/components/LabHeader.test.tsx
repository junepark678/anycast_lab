import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LabHeader } from './LabHeader';

afterEach(cleanup);

function renderHeader(
  persistenceReady: boolean,
  callbacks: { onProjectNameChange?: ReturnType<typeof vi.fn>; onManageProjects?: ReturnType<typeof vi.fn> } = {},
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
    onSave={noop}
    onExport={noop}
    onImport={noop}
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
});
