import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LabHeader } from './LabHeader';

function renderHeader(persistenceReady: boolean) {
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
    onProjectNameChange={noop}
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

    expect(screen.getAllByTitle('Preparing local storage…')).toHaveLength(2);
    for (const control of screen.getAllByTitle('Preparing local storage…')) {
      expect(control).toBeDisabled();
    }

    view.unmount();
    renderHeader(true);
    expect(screen.getByTitle('Save now')).toBeEnabled();
    expect(screen.getByTitle('Import project')).toBeEnabled();
  });
});
