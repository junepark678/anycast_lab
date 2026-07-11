import type { ConfigDiagnostic, LabFile, LabNode } from '../types';

export interface SourceFragment {
  file: string;
  content: string;
  startLine: number;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export function selectEntrypoint(node: LabNode, defaults: string[]): LabFile | undefined {
  const requested = node.appliance.entrypoint;
  if (requested) return node.files.find((file) => file.path === requested);
  const marked = node.files.find((file) => file.entrypoint);
  if (marked) return marked;
  for (const path of defaults) {
    const match = node.files.find((file) => file.path === path);
    if (match) return match;
  }
  return node.files[0];
}

/** Expands BIRD-style includes while retaining source path and starting line. */
export function expandIncludes(
  files: LabFile[],
  entrypoint: LabFile,
  diagnostics: ConfigDiagnostic[],
): SourceFragment[] {
  const fragments: SourceFragment[] = [];
  const stack: string[] = [];

  const visit = (file: LabFile): void => {
    if (stack.includes(file.path)) {
      diagnostics.push({
        severity: 'error',
        code: 'config.include-cycle',
        file: file.path,
        message: `Include cycle detected: ${[...stack, file.path].join(' -> ')}`,
      });
      return;
    }
    stack.push(file.path);
    const includePattern = /^\s*include\s+(?:"([^"]+)"|'([^']+)'|([^;\s]+))\s*;\s*$/gm;
    let cursor = 0;
    let line = 1;
    for (const match of file.content.matchAll(includePattern)) {
      const index = match.index ?? 0;
      const preceding = file.content.slice(cursor, index);
      if (preceding !== '') fragments.push({ file: file.path, content: preceding, startLine: line });
      line += (file.content.slice(cursor, index + match[0].length).match(/\n/g) ?? []).length;
      cursor = index + match[0].length;

      const path = match[1] ?? match[2] ?? match[3] ?? '';
      const matcher = globToRegExp(path);
      const matches = files.filter((candidate) => matcher.test(candidate.path)).sort((a, b) => a.path.localeCompare(b.path));
      if (matches.length === 0) {
        diagnostics.push({
          severity: 'error',
          code: 'config.include-missing',
          file: file.path,
          line,
          message: `Included file ${path} was not supplied to the appliance.`,
        });
      }
      for (const included of matches) visit(included);
    }
    const rest = file.content.slice(cursor);
    if (rest !== '') fragments.push({ file: file.path, content: rest, startLine: line });
    stack.pop();
  };

  visit(entrypoint);
  return fragments;
}

export function cloneSourceFiles(files: LabFile[]): LabFile[] {
  return files.map((file) => ({ ...file }));
}
