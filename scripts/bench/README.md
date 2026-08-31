# Performance benchmark harness

Tooling to measure — and prevent regressions in — Spectral's wall time and memory
on large documents. Everything here is deterministic and needs no network.

## Why

Linting a ~20MB OpenAPI document took **134 seconds and 1.73GB RSS**. Profiling
attributed 92% of the wall time to `$ref` resolution, which scaled at roughly
`O(n^2.7)`. Three distinct quadratic algorithms were responsible; see
[Findings](#findings) below.

## Quick start

```bash
# 1. build the packages under test
yarn build

# 2. generate a deterministic corpus (no input spec required)
node scripts/bench/gen-synthetic.mjs --target 22 --out corpora/synth-22mb.yaml

#    ...or grow one of your own real specs to a target size
node scripts/bench/synth.mjs --in corpora/github.yaml --out corpora/synth-22mb.yaml --target 22

# 3. measure
node --expose-gc --max-old-space-size=8192 scripts/bench/bench.mjs --doc corpora/synth-22mb.yaml
```

`corpora/` is gitignored — generate locally, don't commit multi-megabyte fixtures.

## The tools

| script | what it answers |
|---|---|
| `gen-synthetic.mjs` | Deterministic corpus with realistic `$ref` fan-in. `--dirty` strips descriptions/operationIds so the ruleset produces ~4 findings per operation (use it to measure the result pipeline). |
| `synth.mjs` | Same, but grows a **real** spec you supply, keeping `components` shared. |
| `bench.mjs` | Wall time + memory per lifecycle phase (parse / resolve / formats / run / prepareResults), median over N runs, GC time, peak RSS. **The primary harness.** |
| `bench-attrib.mjs` | Splits the `run` phase further: nimma compile vs traversal vs rule functions vs `processTargetResults`. |
| `mem-attrib.mjs` | Retained size of each big structure, by dropping its only reference and forcing GC. Answers "AST vs data graph vs resolved graph". |
| `heap-top.mjs` | Heap snapshot → top constructors by aggregate shallow size. |
| `prof-top.mjs` | Summarises a `--cpu-prof` `.cpuprofile` into top self-time functions, no DevTools needed. |
| `verify-equivalence.mjs` | sha256 over normalised findings. **Run before/after every perf change** — output must not move. |

### Getting a CPU profile

```bash
node --cpu-prof --cpu-prof-dir=/tmp/prof --cpu-prof-name=run.cpuprofile \
     scripts/bench/bench.mjs --doc corpora/synth-22mb.yaml
node scripts/bench/prof-top.mjs /tmp/prof/run.cpuprofile --top 25
```

## Findings

Measured on Node v24.5.0, `oas` ruleset (56 rules), 20.5MB corpus from
`gen-synthetic.mjs --target 22`.

### Baseline vs fixed

Back-to-back A/B on the same 20.4MB corpus and machine, `--repeat 1`:

| phase | before | after | |
|---|---|---|---|
| parse | 3,666 ms | 3,181 ms | — |
| **resolve** | **123,219 ms** | **7,696 ms** | **16.0x** |
| run | 7,611 ms | 5,004 ms | 1.5x |
| **TOTAL** | **134,499 ms** | **15,883 ms** | **8.5x** |
| peak RSS | 1,733 MB | 1,640 MB | unchanged |

For reference, aliasing `resolved` to `unresolved` (i.e. the ceiling if `$ref`
resolution were virtualised rather than materialised) gives 6.1s / 890MB.

Output is byte-identical (`verify-equivalence.mjs`, 21,648-finding corpus) and the
full suite passes (260 core + 762 rulesets tests).

> Absolute times were captured on a loaded machine (load avg ~11 on 32 cores), so
> they run high; the before/after pair was measured back to back under identical
> conditions, so the **ratios** are the meaningful figures. Re-run both sides
> yourself rather than trusting the absolute milliseconds.

### The three quadratic algorithms

1. **`dependency-graph@0.11.0` `addDependency`** — scans the edge array with
   `Array.indexOf` before every insert. With `$ref` fan-in, `incomingEdges` for a
   shared schema grows to O(N), making edge insertion **O(E²)**. `overallOrder`'s
   circular pass has the same problem via `result.indexOf(node)`.
   Patched in `patches/dependency-graph+0.11.0.patch`. **123s → ~14s**
   *Still present in dependency-graph 1.0.0 — worth reporting upstream.*

2. **`@stoplight/json-ref-resolver@3.1.6` `runner.js`** — calls
   `pointerStemGraph.dependenciesOf(pointer)` (a graph DFS) *inside* the
   per-dependant loop, where it is loop-invariant.
   Patched in `patches/@stoplight+json-ref-resolver+3.1.6.patch`. **~14s → 7.7s**

3. **operationId/messageId uniqueness rules** — collected seen ids in an `Array`
   and tested membership with `.includes()`, i.e. **O(n²)** over operations.
   `oasOpIdUnique` alone was 27.7% of total CPU once the resolver was fixed.
   Fixed in source (`Set`). **`run` phase 7.6s → 5.0s** (and 5.7s → 2.9s with resolution virtualised)

### Memory decomposition (post-GC live heap, 20.5MB document)

| component | heap | |
|---|---|---|
| source string | 21MB | |
| **YAML AST** | **362MB** | retained only to answer `getRangeForJsonPath` |
| lineMap | 7MB | |
| data graph | 146MB | ~7x source — the real payload |
| resolved graph | +158MB live / +1.2GB transient | immer copy-on-write churn |

The three fixes are **CPU-only**. Memory needs architectural work: the AST is 2.5x
the size of the data it describes and exists for a few thousand findings, and
materialising the resolved graph costs both memory and ~2x on the `run` phase
because rules then traverse the inlined duplicates.

## Round 2: the result pipeline

The corpus above produces **zero findings**, which makes it blind to everything
downstream of a rule match. `gen-synthetic.mjs --dirty` strips descriptions and
operationIds so the same document yields ~50k findings, and that exposed two more
wins. Back-to-back A/B on a 21.3MB `--dirty` corpus, two passes:

| config | run phase | total | peak RSS |
|---|---|---|---|
| after round 1 | 19,202 / 20,050 ms | 31,369 / 32,670 ms | 2,220 MB |
| + AST key index | 5,811 / 5,709 ms | 18,198 / 17,684 ms | 2,222 MB |
| + modern nimma build | **4,408 / 4,364 ms** | **16,637 / 16,580 ms** | 2,222 MB |

**3.4x on the run phase, 1.93x overall**, output byte-identical, peak RSS unchanged.

1. **`@stoplight/yaml` `findNodeAtPath`** rebuilt `getMappings()` and linear-scanned
   it at every MAP node on every path, so range resolution was O(F x depth x fanout)
   with a fresh array allocation per step. Replaced with a key->node `Map` cached in
   a `WeakMap` on the AST node. Patched in `patches/@stoplight+yaml+4.3.0.patch`.
   Map keys are the raw `item.key.value` so lookup stays SameValueZero, matching the
   `===` the scan used -- stringifying would make `'200'` and `200` collide.
2. **`nimma/legacy`** is Babel-downcompiled for Node 12; its lowered private fields
   make every traversal step a pair of WeakMap lookups. spectral-core requires
   Node >= 16.20 and nimma's modern build supports >= 14.13, so the legacy build
   was pure cost. One-line import change.

### Measured and rejected

- **Selective key ordering.** `preserveKeyOrder: true` wraps every map in an
  ordering Proxy, but JS already preserves insertion order for string keys -- only
  integer-like keys (in OpenAPI: response status codes) are reordered. Wrapping only
  the maps that need it preserves semantics exactly and cuts parse 2.9x... but makes
  the run phase **worse** (12.8s -> 16.4s): the mixed plain/Proxy shapes turn
  monomorphic property access in rule functions megamorphic. Uniformity beats
  avoiding the Proxy. Do not do this.
- **`preserveKeyOrder: false` outright** is 1.28x and -363MB RSS, and no bundled rule
  depends on it (`alphabetical` is only used on `tags`, an array). But it changes the
  iteration order of integer-like keys, which is observable through the public API
  and by custom rulesets. It belongs behind a documented opt-in, not a silent flip.

## Caveats

- The synthetic corpus is not your spec. Re-run against a real document before
  trusting the multipliers; the `$ref` fan-in shape is what drives the quadratic
  blow-up, and specs with few shared components will show smaller wins.
- `patches/` only fixes this repo's install. Downstream consumers of the published
  `@stoplight/spectral-*` packages still get the unpatched transitive dependencies.
