import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { KnowledgeGraphManager, Entity, Relation, KnowledgeGraph } from '../index.js';

/**
 * Spec for the unbounded knowledge-graph storage fix.
 *
 * create_entities, add_observations, and create_relations persist caller-supplied
 * strings by rewriting the whole memory file, and every later read or mutation
 * loads that file back in full. These tests are the required bounds. They fail
 * while a write of any size is accepted, and they pass once writes that exceed
 * a bound are rejected before the memory file, or any temporary file, is written.
 *
 * Field lengths are JavaScript string lengths (UTF-16 code units). The graph
 * bound is the UTF-8 byte length of the exact body saveGraph writes:
 * one JSON object per line (entities, then relations) joined by "\n", plus a
 * trailing "\n". Rejection errors must mention a limit (the message matches
 * /limit|exceed|too large|too big/i). A call that contains any over-limit
 * field, or that would make the serialized file larger than the byte bound,
 * must fail as a whole: earlier items in that call are not written, the
 * previous file bytes are left untouched, and a later call on the same
 * manager must not persist data from the rejected call.
 *
 * Not covered here, because those tools do not append caller strings to the
 * stored graph: delete_entities, delete_observations, delete_relations.
 * read_graph, search_nodes, open_nodes, and the knowledge-graph resource only
 * load the file; search_nodes already caps its query.
 */
const MAX_ENTITY_NAME_CHARS = 1024;
const MAX_ENTITY_TYPE_CHARS = 1024;
const MAX_OBSERVATION_CHARS = 8192;
const MAX_OBSERVATIONS_PER_ENTITY = 128;
const MAX_RELATION_TYPE_CHARS = 1024;
const MAX_SERIALIZED_GRAPH_BYTES = 1024 * 1024;

const LIMIT_ERROR = /limit|exceed|too large|too big/i;

function serializedGraph(graph: KnowledgeGraph): string {
  const lines = [
    ...graph.entities.map(entity => JSON.stringify({
      type: 'entity',
      name: entity.name,
      entityType: entity.entityType,
      observations: entity.observations,
    })),
    ...graph.relations.map(relation => JSON.stringify({
      type: 'relation',
      from: relation.from,
      to: relation.to,
      relationType: relation.relationType,
    })),
  ];
  return lines.join('\n') + '\n';
}

function serializedSize(graph: KnowledgeGraph): number {
  return Buffer.byteLength(serializedGraph(graph), 'utf8');
}

function textOfLength(prefix: string, length: number): string {
  if (prefix.length > length) {
    throw new Error(`prefix longer than ${length}`);
  }
  return prefix + 'x'.repeat(length - prefix.length);
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * The rejected call must not write, rename, or unlink anything. loadGraph may
 * read the existing file; it must not rewrite it.
 */
async function expectRejectedWithoutWriting(
  directory: string,
  filePath: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  const before = await readFileOrNull(filePath);
  const namesBefore = (await fs.readdir(directory)).sort();
  const writeFileSpy = vi.spyOn(fs, 'writeFile');
  const renameSpy = vi.spyOn(fs, 'rename');
  const unlinkSpy = vi.spyOn(fs, 'unlink');
  const appendFileSpy = vi.spyOn(fs, 'appendFile');

  let rejected = false;
  let rejectionError: unknown;
  let writeCalls = 0;
  let renameCalls = 0;
  let unlinkCalls = 0;
  let appendCalls = 0;
  try {
    await operation();
  } catch (error) {
    rejected = true;
    rejectionError = error;
  } finally {
    writeCalls = writeFileSpy.mock.calls.length;
    renameCalls = renameSpy.mock.calls.length;
    unlinkCalls = unlinkSpy.mock.calls.length;
    appendCalls = appendFileSpy.mock.calls.length;
    writeFileSpy.mockRestore();
    renameSpy.mockRestore();
    unlinkSpy.mockRestore();
    appendFileSpy.mockRestore();
  }

  expect(rejected, 'over-limit write must be rejected').toBe(true);
  expect(rejectionError).toBeInstanceOf(Error);
  expect((rejectionError as Error).message).toMatch(LIMIT_ERROR);
  expect(writeCalls, 'memory file must not be written').toBe(0);
  expect(renameCalls, 'memory file must not be replaced').toBe(0);
  expect(unlinkCalls, 'memory file must not be removed').toBe(0);
  expect(appendCalls, 'memory file must not be appended').toBe(0);
  expect(await readFileOrNull(filePath)).toEqual(before);
  expect((await fs.readdir(directory)).sort()).toEqual(namesBefore);
}

describe('knowledge graph storage bounds', () => {
  let directory: string;
  let filePath: string;
  let manager: KnowledgeGraphManager;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-memory-bounds-'));
    filePath = path.join(directory, 'memory.jsonl');
    manager = new KnowledgeGraphManager(filePath);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  describe('limits that still allow ordinary memory', () => {
    it('stores an entity whose name, type, and observation are exactly at the per-field limits', async () => {
      const entity: Entity = {
        name: textOfLength('n', MAX_ENTITY_NAME_CHARS),
        entityType: textOfLength('t', MAX_ENTITY_TYPE_CHARS),
        observations: [textOfLength('o', MAX_OBSERVATION_CHARS)],
      };

      await manager.createEntities([entity]);

      const reloaded = await new KnowledgeGraphManager(filePath).readGraph();
      expect(reloaded.entities).toEqual([entity]);
      expect(serializedSize(reloaded)).toBeLessThanOrEqual(MAX_SERIALIZED_GRAPH_BYTES);
    });

    it('stores an entity with exactly the maximum number of observations', async () => {
      const observations = Array.from({ length: MAX_OBSERVATIONS_PER_ENTITY }, (_, index) => `fact-${index}`);
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations },
      ]);

      const reloaded = await new KnowledgeGraphManager(filePath).readGraph();
      expect(reloaded.entities[0].observations).toEqual(observations);
    });

    it('stores a relation whose type is exactly at the limit', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: [] },
        { name: 'Bob', entityType: 'person', observations: [] },
      ]);
      const relation: Relation = {
        from: 'Alice',
        to: 'Bob',
        relationType: textOfLength('r', MAX_RELATION_TYPE_CHARS),
      };

      await manager.createRelations([relation]);

      const reloaded = await new KnowledgeGraphManager(filePath).readGraph();
      expect(reloaded.relations).toEqual([relation]);
    });
  });

  describe('createEntities', () => {
    it('rejects an entity name longer than the limit and does not create the memory file', async () => {
      const name = textOfLength('n', MAX_ENTITY_NAME_CHARS + 1);
      await expectRejectedWithoutWriting(directory, filePath, () => manager.createEntities([
        { name, entityType: 'person', observations: ['kept'] },
      ]));

      const reloaded = await new KnowledgeGraphManager(filePath).readGraph();
      expect(reloaded).toEqual({ entities: [], relations: [] });
    });

    it('rejects an entity type longer than the limit and does not create the memory file', async () => {
      const entityType = textOfLength('t', MAX_ENTITY_TYPE_CHARS + 1);
      await expectRejectedWithoutWriting(directory, filePath, () => manager.createEntities([
        { name: 'Alice', entityType, observations: ['kept'] },
      ]));

      expect(await new KnowledgeGraphManager(filePath).readGraph()).toEqual({ entities: [], relations: [] });
    });

    it('rejects one oversized observation and does not persist the rest of that call', async () => {
      const marker = textOfLength('oversized-observation-', MAX_OBSERVATION_CHARS + 1);
      await expectRejectedWithoutWriting(directory, filePath, () => manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['small'] },
        { name: 'Bob', entityType: 'person', observations: [marker] },
      ]));

      const reloaded = await new KnowledgeGraphManager(filePath).readGraph();
      expect(reloaded.entities).toEqual([]);
      expect(JSON.stringify(reloaded)).not.toContain('oversized-observation-');
      expect(JSON.stringify(reloaded)).not.toContain('Alice');
    });

    it('rejects a new entity with more observations than the limit', async () => {
      const observations = Array.from({ length: MAX_OBSERVATIONS_PER_ENTITY + 1 }, (_, index) => `fact-${index}`);
      await expectRejectedWithoutWriting(directory, filePath, () => manager.createEntities([
        { name: 'Alice', entityType: 'person', observations },
      ]));

      expect(await manager.readGraph()).toEqual({ entities: [], relations: [] });
    });

    it('rejects one call whose entities are individually legal but serialize past the graph limit', async () => {
      const entities: Entity[] = [];
      const graph: KnowledgeGraph = { entities: [], relations: [] };
      let guard = 0;
      while (serializedSize(graph) <= MAX_SERIALIZED_GRAPH_BYTES) {
        const entity: Entity = {
          name: `entity-${entities.length}`,
          entityType: 'note',
          observations: [textOfLength(`obs-${entities.length}-`, MAX_OBSERVATION_CHARS)],
        };
        entities.push(entity);
        graph.entities.push(entity);
        guard += 1;
        if (guard > 10_000) {
          throw new Error('serialized graph never exceeded the byte limit');
        }
      }
      expect(serializedSize(graph)).toBeGreaterThan(MAX_SERIALIZED_GRAPH_BYTES);
      expect(entities.length).toBeGreaterThan(1);
      expect(entities.every(entity =>
        entity.name.length <= MAX_ENTITY_NAME_CHARS &&
        entity.entityType.length <= MAX_ENTITY_TYPE_CHARS &&
        entity.observations.length <= MAX_OBSERVATIONS_PER_ENTITY &&
        entity.observations.every(observation => observation.length <= MAX_OBSERVATION_CHARS)
      )).toBe(true);

      await expectRejectedWithoutWriting(directory, filePath, () => manager.createEntities(entities));

      const reloaded = await new KnowledgeGraphManager(filePath).readGraph();
      expect(reloaded.entities).toEqual([]);
    });
  });

  describe('addObservations', () => {
    it('rejects an oversized observation and leaves the existing graph to be reloaded', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['works at Acme'] },
      ]);
      const marker = textOfLength('oversized-observation-', MAX_OBSERVATION_CHARS + 1);

      await expectRejectedWithoutWriting(directory, filePath, () => manager.addObservations([
        { entityName: 'Alice', contents: ['still small', marker] },
      ]));

      await manager.addObservations([
        { entityName: 'Alice', contents: ['after reject'] },
      ]);

      const reloaded = await new KnowledgeGraphManager(filePath).readGraph();
      expect(reloaded.entities).toEqual([
        {
          name: 'Alice',
          entityType: 'person',
          observations: ['works at Acme', 'after reject'],
        },
      ]);

      const searched = await new KnowledgeGraphManager(filePath).searchNodes('alice');
      expect(JSON.stringify(searched)).not.toContain('oversized-observation-');
      const opened = await new KnowledgeGraphManager(filePath).openNodes(['Alice']);
      expect(opened.entities[0].observations).toEqual(['works at Acme', 'after reject']);
    });

    it('rejects the observation that would push an entity past the count limit', async () => {
      const observations = Array.from({ length: MAX_OBSERVATIONS_PER_ENTITY }, (_, index) => `fact-${index}`);
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations },
      ]);

      await expectRejectedWithoutWriting(directory, filePath, () => manager.addObservations([
        { entityName: 'Alice', contents: ['one-more'] },
      ]));

      const reloaded = await new KnowledgeGraphManager(filePath).readGraph();
      expect(reloaded.entities[0].observations).toEqual(observations);
    });

    it('rejects the later call that would push the serialized file past the byte limit', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: [] },
      ]);

      let added = 0;
      for (;;) {
        const current = await manager.readGraph();
        const observation = textOfLength(`chunk-${added}-`, MAX_OBSERVATION_CHARS);
        const next: KnowledgeGraph = {
          entities: current.entities.map(entity => ({
            ...entity,
            observations: [...entity.observations, observation],
          })),
          relations: current.relations,
        };
        if (serializedSize(next) > MAX_SERIALIZED_GRAPH_BYTES) {
          expect(added).toBeGreaterThan(0);
          expect(added).toBeLessThan(MAX_OBSERVATIONS_PER_ENTITY);
          await expectRejectedWithoutWriting(directory, filePath, () => manager.addObservations([
            { entityName: 'Alice', contents: [observation] },
          ]));
          break;
        }
        await manager.addObservations([
          { entityName: 'Alice', contents: [observation] },
        ]);
        added += 1;
        if (added > MAX_OBSERVATIONS_PER_ENTITY) {
          throw new Error('byte limit was not reached before the observation count limit');
        }
      }

      const reloaded = await new KnowledgeGraphManager(filePath).readGraph();
      expect(reloaded.entities).toHaveLength(1);
      expect(reloaded.entities[0].observations).toHaveLength(added);
      expect(serializedSize(reloaded)).toBeLessThanOrEqual(MAX_SERIALIZED_GRAPH_BYTES);
      expect(reloaded.entities[0].observations.some(observation => observation.startsWith(`chunk-${added}-`))).toBe(false);

      const searched = await new KnowledgeGraphManager(filePath).searchNodes('chunk-0-');
      expect(searched.entities).toHaveLength(1);
      expect(JSON.stringify(searched)).not.toContain(`chunk-${added}-`);
    });
  });

  describe('createRelations', () => {
    it('rejects a relation type longer than the limit and keeps the entities', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: [] },
        { name: 'Bob', entityType: 'person', observations: [] },
      ]);
      const relationType = textOfLength('r', MAX_RELATION_TYPE_CHARS + 1);

      await expectRejectedWithoutWriting(directory, filePath, () => manager.createRelations([
        { from: 'Alice', to: 'Bob', relationType },
      ]));

      const reloaded = await new KnowledgeGraphManager(filePath).readGraph();
      expect(reloaded.relations).toEqual([]);
      expect(reloaded.entities.map(entity => entity.name)).toEqual(['Alice', 'Bob']);
    });

    it('rejects one call whose relations are individually legal but serialize past the graph limit', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: [] },
        { name: 'Bob', entityType: 'person', observations: [] },
      ]);
      const base = await manager.readGraph();
      const relations: Relation[] = [];
      let guard = 0;
      for (;;) {
        const candidate: Relation = {
          from: 'Alice',
          to: 'Bob',
          relationType: textOfLength(`rel-${relations.length}-`, MAX_RELATION_TYPE_CHARS),
        };
        const size = serializedSize({
          entities: base.entities,
          relations: [...relations, candidate],
        });
        relations.push(candidate);
        guard += 1;
        if (size > MAX_SERIALIZED_GRAPH_BYTES) {
          break;
        }
        if (guard > 100_000) {
          throw new Error('serialized graph never exceeded the byte limit');
        }
      }
      expect(relations.length).toBeGreaterThan(1);
      expect(serializedSize({ entities: base.entities, relations })).toBeGreaterThan(MAX_SERIALIZED_GRAPH_BYTES);

      await expectRejectedWithoutWriting(directory, filePath, () => manager.createRelations(relations));

      const reloaded = await new KnowledgeGraphManager(filePath).readGraph();
      expect(reloaded.relations).toEqual([]);
      expect(serializedSize(reloaded)).toBeLessThanOrEqual(MAX_SERIALIZED_GRAPH_BYTES);
    });
  });
});
