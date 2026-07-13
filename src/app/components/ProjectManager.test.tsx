import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../../persistence/types';
import { type ProjectManagerProps, ProjectManager } from './ProjectManager';

afterEach(cleanup);

const projects: ProjectSummary[] = [
  {
    id: 'current',
    name: 'Global anycast demo',
    schemaVersion: 1,
    revision: 8,
    createdAt: Date.now() - 50_000,
    updatedAt: Date.now() - 20_000,
    lastOpenedAt: Date.now() - 10_000,
  },
  {
    id: 'older',
    name: 'Edge experiments',
    schemaVersion: 1,
    revision: 3,
    createdAt: Date.now() - 100_000,
    updatedAt: Date.now() - 80_000,
    lastOpenedAt: Date.now() - 50_000,
  },
];

function callbacks() {
  return {
    onOpen: vi.fn(async () => true),
    onCreate: vi.fn(async () => true),
    onRename: vi.fn(async () => true),
    onDuplicate: vi.fn(async () => true),
    onDelete: vi.fn(async () => true),
    onExport: vi.fn(async () => true),
  };
}

function props(overrides: Partial<ProjectManagerProps> = {}): ProjectManagerProps {
  return {
    open: true,
    onClose: vi.fn(),
    projects,
    activeProjectId: 'current',
    backend: 'indexeddb',
    busy: false,
    loading: false,
    error: null,
    clearError: vi.fn(),
    ...callbacks(),
    onImportClick: vi.fn(),
    ...overrides,
  };
}

describe('ProjectManager', () => {
  it('shows searchable projects in recent order with current, revision, and modified metadata', () => {
    render(<ProjectManager {...props()} />);

    expect(screen.getByRole('searchbox', { name: 'Search projects' })).toHaveFocus();
    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0]!).getByText('Global anycast demo')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Current')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Revision 8')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/^Modified /)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Global anycast demo, current project' })).toBeDisabled();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'edge' } });
    expect(screen.getByText('Edge experiments')).toBeInTheDocument();
    expect(screen.queryByText('Global anycast demo')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
    expect(screen.getByText('No matching projects')).toBeInTheDocument();
  });

  it('opens a project and closes only after the async action succeeds', async () => {
    const onOpen = vi.fn(async () => true);
    const onClose = vi.fn();
    render(<ProjectManager {...props({ onOpen, onClose })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Edge experiments' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('older'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('validates a nonblank new-project name and creates the selected template', async () => {
    const onCreate = vi.fn(async () => true);
    const onClose = vi.fn();
    render(<ProjectManager {...props({ onCreate, onClose })} />);

    const createButton = screen.getByRole('button', { name: 'Create project' });
    expect(createButton).toBeDisabled();
    fireEvent.submit(createButton.closest('form')!);
    expect(screen.getByText('Project name is required.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /Blank lab/ }));
    fireEvent.change(screen.getByPlaceholderText('My anycast lab'), {
      target: { value: '  My new lab  ' },
    });
    fireEvent.click(createButton);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('blank', 'My new lab'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renames inline with nonblank validation', async () => {
    const onRename = vi.fn(async () => true);
    render(<ProjectManager {...props({ onRename })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename Edge experiments' }));
    const input = screen.getByRole('textbox', { name: 'New name for Edge experiments' });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save name for Edge experiments' })).toBeDisabled();

    fireEvent.change(input, { target: { value: '  Better edge lab  ' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('older', 'Better edge lab'));
    expect(screen.queryByRole('textbox', { name: 'New name for Edge experiments' })).not.toBeInTheDocument();
  });

  it('duplicates and exports a selected project', async () => {
    const onDuplicate = vi.fn(async () => true);
    const onExport = vi.fn(async () => true);
    render(<ProjectManager {...props({ onDuplicate, onExport })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Edge experiments' }));
    await waitFor(() => expect(onDuplicate).toHaveBeenCalledWith('older'));
    fireEvent.click(screen.getByRole('button', { name: 'Export Edge experiments' }));
    await waitFor(() => expect(onExport).toHaveBeenCalledWith('older'));
  });

  it('uses an in-app named confirmation before deletion', async () => {
    const onDelete = vi.fn(async () => true);
    render(<ProjectManager {...props({ onDelete })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Edge experiments' }));
    const confirmation = screen.getByRole('group', { name: 'Delete Edge experiments?' });
    expect(within(confirmation).getByText('Delete “Edge experiments”?')).toBeInTheDocument();
    expect(within(confirmation).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Delete Edge experiments?' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Edge experiments' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Edge experiments' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Delete Edge experiments?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('older'));
    expect(screen.queryByRole('group', { name: 'Delete Edge experiments?' })).not.toBeInTheDocument();
  });

  it('exposes temporary-storage, controlled error, loading, and empty states', () => {
    const clearError = vi.fn();
    const view = render(<ProjectManager {...props({ backend: 'memory', error: 'Storage failed.', clearError })} />);

    expect(screen.getByRole('status')).toHaveTextContent('lost when this tab closes');
    expect(screen.getByRole('alert')).toHaveTextContent('Storage failed.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss project error' }));
    expect(clearError).toHaveBeenCalledOnce();

    view.rerender(<ProjectManager {...props({ projects: [], loading: true })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading projects');
    view.rerender(<ProjectManager {...props({ projects: [] })} />);
    expect(screen.getByText('No saved projects yet')).toBeInTheDocument();
  });

  it('hands import off to the existing picker and closes the manager', () => {
    const onImportClick = vi.fn();
    const onClose = vi.fn();
    render(<ProjectManager {...props({ onImportClick, onClose })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(onImportClick).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
