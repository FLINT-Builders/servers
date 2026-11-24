import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { KnowledgeGraphManager } from '../index.js';

/**
 * The graph is persisted by saveGraph(), which every mutation calls:
 * createEntities, createRelations, addObservations, deleteEntities,
 * deleteObservations, and deleteRelations.
 *
 * saveGraph() writes a new temporary file with fs.writeFile and no mode,
 * then renames it over the memory file. fs.writeFile defaults to mode 0o666
 * and the kernel applies the process umask, so a typical umask of 0o022
 * leaves the graph at 0o644. The rename replaces the inode, so a later
 * mutation also drops a manual chmod back to that umask mode.
 *
 * These tests require the file that holds the graph to be owner read/write
 * only (mode 0600) after every mutation, including when the parent directory
 * is world-traversable and when the process umask would otherwise leave
 * group or world bits set.
 *
 * Untested: ensureMemoryFilePath() migration. That path renames an existing
 * legacy memory.json onto memory.jsonl and does not create a new file, so it
 * preserves whatever mode the legacy file already had. It is not one of the
 * mutation saves.
 */

const OWNER_ONLY_MODE = 0o600;
const OBSERVATION = 'PLACEHOLDER_OBSERVATION';

function assertOwnerOnly(mode: number): void {
  const octal = (mode & 0o777).toString(8).padStart(3, '0');
  expect(octal, `graph file mode is ${octal}, expected 600`).toBe('600');
}

async function worldTraversableDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-memory-mode-'));
  // Package directories and other install prefixes are commonly 0755, so
  // another local user who can reach this directory can open files inside it.
  await fs.chmod(directory, 0o755);
  return directory;
}

describe('knowledge graph file mode', () => {
  let directory: string;
  let memoryFilePath: string;
  let previousUmask: number;

  beforeEach(async () => {
    directory = await worldTraversableDir();
    memoryFilePath = path.join(directory, 'memory.jsonl');
    previousUmask = process.umask(0o022);
  });

  afterEach(async () => {
    process.umask(previousUmask);
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function seed(): Promise<KnowledgeGraphManager> {
    const manager = new KnowledgeGraphManager(memoryFilePath);
    await manager.createEntities([
      { name: 'Project', entityType: 'note', observations: [OBSERVATION] },
    ]);
    return manager;
  }

  async function widenMemoryFile(): Promise<void> {
    // A manual chmod must not be the only thing keeping the graph private:
    // the next save replaces the inode.
    await fs.chmod(memoryFilePath, 0o666);
  }

  it('creates the graph as owner-only under a typical umask', async () => {
    const manager = new KnowledgeGraphManager(memoryFilePath);
    await manager.createEntities([
      { name: 'Project', entityType: 'note', observations: [OBSERVATION] },
    ]);

    const stat = await fs.stat(memoryFilePath);
    assertOwnerOnly(stat.mode);
    const stored = await fs.readFile(memoryFilePath, 'utf-8');
    expect(stored).toContain(OBSERVATION);

    const parent = await fs.stat(directory);
    expect(parent.mode & 0o001).toBe(0o001);
  });

  it('creates the graph as owner-only when the umask grants every bit', async () => {
    process.umask(0o000);
    const manager = new KnowledgeGraphManager(memoryFilePath);
    await manager.createEntities([
      { name: 'Project', entityType: 'note', observations: [OBSERVATION] },
    ]);

    const stat = await fs.stat(memoryFilePath);
    assertOwnerOnly(stat.mode);
    expect(stat.mode & 0o077).toBe(0);
    expect(stat.mode & OWNER_ONLY_MODE).toBe(OWNER_ONLY_MODE);
  });

  it('keeps owner-only mode when createEntities rewrites an existing graph', async () => {
    const manager = await seed();
    await widenMemoryFile();

    await manager.createEntities([
      { name: 'Other', entityType: 'note', observations: ['second observation'] },
    ]);

    assertOwnerOnly((await fs.stat(memoryFilePath)).mode);
    expect(await fs.readFile(memoryFilePath, 'utf-8')).toContain(OBSERVATION);
  });

  it('keeps owner-only mode when createRelations rewrites the graph', async () => {
    const manager = await seed();
    await manager.createEntities([
      { name: 'Other', entityType: 'note', observations: [] },
    ]);
    await widenMemoryFile();

    await manager.createRelations([
      { from: 'Project', to: 'Other', relationType: 'links' },
    ]);

    assertOwnerOnly((await fs.stat(memoryFilePath)).mode);
    expect(await fs.readFile(memoryFilePath, 'utf-8')).toContain(OBSERVATION);
  });

  it('keeps owner-only mode when addObservations rewrites the graph', async () => {
    const manager = await seed();
    await widenMemoryFile();

    await manager.addObservations([
      { entityName: 'Project', contents: ['follow-up observation'] },
    ]);

    assertOwnerOnly((await fs.stat(memoryFilePath)).mode);
    const stored = await fs.readFile(memoryFilePath, 'utf-8');
    expect(stored).toContain(OBSERVATION);
    expect(stored).toContain('follow-up observation');
  });

  it('keeps owner-only mode when deleteEntities rewrites the graph', async () => {
    const manager = await seed();
    await manager.createEntities([
      { name: 'Other', entityType: 'note', observations: ['keep me'] },
    ]);
    await widenMemoryFile();

    await manager.deleteEntities(['Project']);

    assertOwnerOnly((await fs.stat(memoryFilePath)).mode);
    const stored = await fs.readFile(memoryFilePath, 'utf-8');
    expect(stored).not.toContain(OBSERVATION);
    expect(stored).toContain('keep me');
  });

  it('keeps owner-only mode when deleteObservations rewrites the graph', async () => {
    const manager = await seed();
    await widenMemoryFile();

    await manager.deleteObservations([
      { entityName: 'Project', observations: [OBSERVATION] },
    ]);

    assertOwnerOnly((await fs.stat(memoryFilePath)).mode);
    const stored = await fs.readFile(memoryFilePath, 'utf-8');
    expect(stored).not.toContain(OBSERVATION);
    expect(stored).toContain('Project');
  });

  it('keeps owner-only mode when deleteRelations rewrites the graph', async () => {
    const manager = await seed();
    await manager.createEntities([
      { name: 'Other', entityType: 'note', observations: [] },
    ]);
    await manager.createRelations([
      { from: 'Project', to: 'Other', relationType: 'links' },
    ]);
    await widenMemoryFile();

    await manager.deleteRelations([
      { from: 'Project', to: 'Other', relationType: 'links' },
    ]);

    assertOwnerOnly((await fs.stat(memoryFilePath)).mode);
    expect(await fs.readFile(memoryFilePath, 'utf-8')).toContain(OBSERVATION);
  });

  it('does not leave a group- or world-accessible file beside the graph', async () => {
    process.umask(0o000);
    const manager = new KnowledgeGraphManager(memoryFilePath);
    await manager.createEntities([
      { name: 'Project', entityType: 'note', observations: [OBSERVATION] },
    ]);
    await manager.addObservations([
      { entityName: 'Project', contents: ['follow-up observation'] },
    ]);

    const names = await fs.readdir(directory);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const stat = await fs.stat(path.join(directory, name));
      assertOwnerOnly(stat.mode);
    }
  });
});
