import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { createEmptyProject } from '../core/types';
import {
  decodeProjectArchive,
  exportProjectArchive,
  ProjectArchiveError,
  projectArchiveFilename,
} from './archive';
import { createProjectMigrator } from './migrations';

interface TestFile {
  path: string;
  content: string | Uint8Array;
  encoding?: 'utf-8';
}

interface TestProject {
  id: string;
  name: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  seed: number;
  nodes: Array<{ id: string; files: TestFile[] }>;
  links: unknown[];
  settings: Record<string, unknown>;
}

function project(): TestProject {
  return {
    id: 'seoul-lab',
    name: 'Seoul / Frankfurt',
    schemaVersion: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    seed: 42,
    nodes: [
      {
        id: 'pop-seoul',
        files: [
          {
            path: '/etc/bird/bird.conf',
            content:
              '# keep spaces  \r\nrouter id 192.0.2.1;\r\n\r\n# 한글\r\n',
            encoding: 'utf-8',
          },
          {
            path: '/var/lib/lab/raw.bin',
            content: new Uint8Array([0, 255, 10, 13, 0, 42]),
          },
        ],
      },
    ],
    links: [],
    settings: {},
  };
}

describe('.anycastlab archives', () => {
  it('uses the validated core LabProject model by default', () => {
    const source = createEmptyProject({ id: 'real-project', name: 'Real project' });
    source.nodes.push({
      id: 'r1',
      name: 'Router 1',
      kind: 'router',
      appliance: { kind: 'bird', runtime: 'compatibility' },
      interfaces: [],
      files: [
        {
          path: '/etc/bird/bird.conf',
          content: 'router id 192.0.2.1;\n',
          encoding: 'utf-8',
          entrypoint: true,
        },
      ],
      state: 'up',
    });

    const imported = decodeProjectArchive(exportProjectArchive(source));

    expect(imported.project).toEqual(source);
  });

  it('round-trips config text and binary files byte-for-byte', () => {
    const source = project();
    const archive = exportProjectArchive(source, {
      exportedAt: '2026-07-11T01:02:03.000Z',
    });
    const zipped = unzipSync(archive);
    const manifest = JSON.parse(strFromU8(zipped['manifest.json']!)) as {
      files: Array<{ archivePath: string }>;
    };

    expect(Object.keys(zipped).sort()).toEqual([
      'files/000000.bin',
      'files/000001.bin',
      'manifest.json',
      'project.json',
    ]);
    expect(Array.from(zipped[manifest.files[0]!.archivePath]!)).toEqual(
      Array.from(
        new TextEncoder().encode(
          source.nodes[0]!.files[0]!.content as string,
        ),
      ),
    );
    expect(Array.from(zipped[manifest.files[1]!.archivePath]!)).toEqual(
      Array.from(source.nodes[0]!.files[1]!.content as Uint8Array),
    );

    const imported = decodeProjectArchive<TestProject>(archive, {
      migrate: createProjectMigrator<TestProject>(),
    });
    expect(imported.project.nodes[0]!.files[0]!.content).toBe(
      source.nodes[0]!.files[0]!.content,
    );
    expect(
      Array.from(imported.project.nodes[0]!.files[1]!.content as Uint8Array),
    ).toEqual(Array.from(source.nodes[0]!.files[1]!.content as Uint8Array));
    expect(imported.manifest.project.id).toBe(source.id);
  });

  it('does not mutate the project while extracting its files', () => {
    const source = project();
    const content = source.nodes[0]!.files[0]!.content;
    exportProjectArchive(source);
    expect(source.nodes[0]!.files[0]!.content).toBe(content);
  });

  it('rejects invalid data and configured size limits', () => {
    expect(() => decodeProjectArchive(new Uint8Array([1, 2, 3]))).toThrow(
      ProjectArchiveError,
    );
    const archive = exportProjectArchive(project());
    expect(() =>
      decodeProjectArchive(archive, { maxArchiveBytes: archive.byteLength - 1 }),
    ).toThrow(/limit/);
  });

  it('creates filesystem-safe archive names', () => {
    expect(projectArchiveFilename('  Seoul / Frankfurt:*  ')).toBe(
      'Seoul - Frankfurt-.anycastlab',
    );
    expect(projectArchiveFilename('...')).toBe('anycast-lab.anycastlab');
  });
});
