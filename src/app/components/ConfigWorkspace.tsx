import { Check, FileCode2, FilePlus2, FileUp, Trash2, X } from 'lucide-react';
import { useRef, type ChangeEvent } from 'react';
import type { ConfigFileView } from '../view-types';

interface Props {
  nodeLabel: string;
  files: ConfigFileView[];
  activePath: string;
  diagnostics: Array<{ severity: 'error' | 'warning' | 'info'; message: string; line?: number }>;
  onSelect: (path: string) => void;
  onChange: (path: string, contents: string) => void;
  onAdd: (path: string, contents: string) => void;
  onDelete: (path: string) => void;
  onClose: () => void;
  onValidate: () => void;
  readOnly?: boolean;
}

export function ConfigWorkspace({ nodeLabel, files, activePath, diagnostics, onSelect, onChange, onAdd, onDelete, onClose, onValidate, readOnly = false }: Props) {
  const file = files.find((candidate) => candidate.path === activePath) ?? files[0];
  const uploadRef = useRef<HTMLInputElement>(null);
  const addBlank = () => {
    const directory = (file?.path ?? activePath).replace(/[^/]+$/, '') || '/etc/';
    const name = window.prompt('Absolute appliance path', `${directory}extra.conf`);
    if (name) onAdd(name, '');
  };
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = [...(event.target.files ?? [])];
    event.target.value = '';
    const directory = (file?.path ?? activePath).replace(/[^/]+$/, '') || '/etc/';
    for (const imported of selected) onAdd(`${directory}${imported.name}`, await imported.text());
  };
  return (
    <section className="config-workspace" aria-label={`${nodeLabel} configuration`}>
      <header className="workspace-header">
        <span><FileCode2 size={16} /><strong>{nodeLabel}</strong><small>native configuration files</small></span>
        <div>
          <button type="button" className="icon-button" disabled={readOnly} title="Add config file" onClick={addBlank}><FilePlus2 size={15} /></button>
          <button type="button" className="icon-button" disabled={readOnly} title="Upload config files" onClick={() => uploadRef.current?.click()}><FileUp size={15} /></button>
          <input ref={uploadRef} className="visually-hidden" type="file" multiple accept=".conf,.cfg,.txt,text/plain" onChange={(event) => void upload(event)} />
          {file && files.length > 1 && <button type="button" className="icon-button" disabled={readOnly} title="Delete current config file" onClick={() => onDelete(file.path)}><Trash2 size={15} /></button>}
          <button type="button" className="button button--secondary" onClick={onValidate}><Check size={15} /> Validate</button>
          <button type="button" className="icon-button" onClick={onClose} title="Close editor"><X size={17} /></button>
        </div>
      </header>
      <div className="file-tabs">
        {files.map((candidate) => (
          <button key={candidate.path} type="button" className={candidate.path === file?.path ? 'is-active' : ''} onClick={() => onSelect(candidate.path)}>
            {candidate.path.split('/').pop()}{candidate.dirty && <i />}
          </button>
        ))}
      </div>
      <div className="config-editor">
        {file ? (
          <textarea
            className="config-textarea"
            aria-label={`${file.path} contents`}
            value={file.contents}
            readOnly={readOnly}
            onChange={(event) => onChange(file.path, event.target.value)}
            onKeyDown={(event) => {
              if (readOnly) return;
              if (event.key !== 'Tab') return;
              event.preventDefault();
              const target = event.currentTarget;
              const start = target.selectionStart;
              const end = target.selectionEnd;
              onChange(file.path, `${target.value.slice(0, start)}  ${target.value.slice(end)}`);
              requestAnimationFrame(() => target.setSelectionRange(start + 2, start + 2));
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        ) : <div className="empty-editor">No configuration files</div>}
      </div>
      {diagnostics.length > 0 && (
        <div className="diagnostics">
          {diagnostics.map((diagnostic, index) => (
            <button key={`${diagnostic.message}-${index}`} type="button" className={`diagnostic diagnostic--${diagnostic.severity}`}>
              <span>{diagnostic.severity}</span>{diagnostic.line && <code>L{diagnostic.line}</code>}<p>{diagnostic.message}</p>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
