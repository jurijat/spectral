import { DepGraph } from 'dependency-graph';

const createGraph = (...nodes: string[]): DepGraph<string> => {
  const graph = new DepGraph<string>();

  for (const node of nodes) {
    graph.addNode(node);
  }

  return graph;
};

describe('dependency-graph edge index', () => {
  test('does not add a dependency more than once', () => {
    const graph = createGraph('a', 'b');

    graph.addDependency('a', 'b');
    graph.addDependency('a', 'b');

    expect(graph.directDependenciesOf('a')).toEqual(['b']);
    expect(graph.directDependantsOf('b')).toEqual(['a']);
  });

  test('allows a removed dependency to be added again', () => {
    const graph = createGraph('a', 'b');

    graph.addDependency('a', 'b');
    graph.removeDependency('a', 'b');
    graph.addDependency('a', 'b');

    expect(graph.directDependenciesOf('a')).toEqual(['b']);
    expect(graph.directDependantsOf('b')).toEqual(['a']);
  });

  test('does not duplicate an existing dependency in a clone', () => {
    const graph = createGraph('a', 'b');
    graph.addDependency('a', 'b');

    const clone = graph.clone();
    clone.addDependency('a', 'b');

    expect(clone.directDependenciesOf('a')).toEqual(['b']);
    expect(clone.directDependantsOf('b')).toEqual(['a']);
  });

  test('keeps the index in sync when a node is removed and re-added', () => {
    const graph = createGraph('a', 'b', 'c');
    graph.addDependency('a', 'b');
    graph.addDependency('b', 'c');

    graph.removeNode('b');

    expect(graph.directDependenciesOf('a')).toEqual([]);
    expect(graph.directDependantsOf('c')).toEqual([]);

    graph.addNode('b');
    graph.addDependency('a', 'b');
    graph.addDependency('b', 'c');

    expect(graph.directDependenciesOf('a')).toEqual(['b']);
    expect(graph.directDependenciesOf('b')).toEqual(['c']);
    expect(graph.directDependantsOf('b')).toEqual(['a']);
    expect(graph.directDependantsOf('c')).toEqual(['b']);
  });

  test('does not collide when node names contain NUL characters', () => {
    const graph = createGraph('a', 'a\0b', 'b\0c', 'c');

    graph.addDependency('a\0b', 'c');
    graph.addDependency('a', 'b\0c');

    expect(graph.directDependenciesOf('a\0b')).toEqual(['c']);
    expect(graph.directDependenciesOf('a')).toEqual(['b\0c']);
    expect(graph.directDependantsOf('c')).toEqual(['a\0b']);
    expect(graph.directDependantsOf('b\0c')).toEqual(['a']);
  });

  test('drops a removed node from the dependants it pointed at', () => {
    const graph = createGraph('a', 'b');
    graph.addDependency('a', 'b');

    graph.removeNode('a');
    graph.addNode('a');
    graph.addDependency('a', 'b');

    expect(graph.directDependantsOf('b')).toEqual(['a']);
  });

  // The index exists only to make addDependency/removeDependency O(1). It is a
  // cache over outgoingEdges, so the property that matters is that the two can
  // never disagree -- a stale index silently duplicates edges, which is how the
  // first version of this patch (a `from\0to` key map that removeDependency and
  // clone never updated) corrupted the resolver's pointer graph.
  test('agrees with outgoingEdges under randomised mutation', () => {
    const NAMES = ['a', 'b', 'c', 'd', 'e', 'f'];
    // xorshift32: deterministic, so a failure is reproducible from the seed.
    const rand = (seed: number): (() => number) => {
      let s = seed >>> 0;
      return () => {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5;
        s >>>= 0;
        return s / 0x1_0000_0000;
      };
    };

    for (let seed = 1; seed <= 150; seed++) {
      const next = rand(seed);
      const pick = (): string => NAMES[Math.floor(next() * NAMES.length)];
      let graph = new DepGraph<string>();
      // Reference model: the set of edges the graph is supposed to hold.
      let model = new Map<string, Set<string>>();
      const trail: string[] = [];

      for (let i = 0; i < 30; i++) {
        const roll = next();
        const from = pick();
        const to = pick();

        if (roll < 0.3) {
          trail.push(`addNode(${from})`);
          graph.addNode(from);
          if (!model.has(from)) model.set(from, new Set());
        } else if (roll < 0.42) {
          trail.push(`removeNode(${from})`);
          graph.removeNode(from);
          model.delete(from);
          for (const targets of model.values()) targets.delete(from);
        } else if (roll < 0.72) {
          trail.push(`addDependency(${from}, ${to})`);
          if (model.has(from) && model.has(to)) {
            graph.addDependency(from, to);
            model.get(from)!.add(to);
          } else {
            expect(() => graph.addDependency(from, to)).toThrow(/Node does not exist/u);
          }
        } else if (roll < 0.9) {
          trail.push(`removeDependency(${from}, ${to})`);
          graph.removeDependency(from, to);
          model.get(from)?.delete(to);
        } else {
          trail.push('clone()');
          graph = graph.clone();
          model = new Map([...model].map(([k, v]) => [k, new Set(v)]));
        }

        const where = `seed ${seed} after ${trail.join(' ; ')}`;
        for (const [node, expected] of model) {
          const outgoing = graph.directDependenciesOf(node);
          // No duplicates: this is what a stale index produces.
          expect(`${where} :: ${node} outgoing`).toBe(
            outgoing.length === new Set(outgoing).size ? `${where} :: ${node} outgoing` : 'DUPLICATE EDGE',
          );
          expect([...outgoing].sort()).toEqual([...expected].sort());

          const dependants = graph.directDependantsOf(node);
          expect(`${where} :: ${node} incoming`).toBe(
            dependants.length === new Set(dependants).size ? `${where} :: ${node} incoming` : 'DUPLICATE EDGE',
          );
          const expectedDependants = [...model].filter(([, t]) => t.has(node)).map(([n]) => n);
          expect([...dependants].sort()).toEqual(expectedDependants.sort());
        }
      }
    }
  });
});
