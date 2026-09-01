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
});
