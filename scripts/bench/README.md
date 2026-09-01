# Performance benchmark harness

Tooling to measure — and prevent regressions in — Spectral's wall time and memory
on large documents. Generated inputs are deterministic, measurement needs no
network, and the harnesses capture provenance for results that naturally vary by
machine and load. The optional APIs.guru fetch records SHA-256 manifests so the
exact downloaded bytes can be identified and audited.

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

| script                   | what it answers                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gen-synthetic.mjs`      | Deterministic corpus with realistic `$ref` fan-in. `--dirty` strips descriptions/operationIds so the ruleset produces ~4 findings per operation (use it to measure the result pipeline).        |
| `synth.mjs`              | Same, but grows a **real** spec you supply, keeping `components` shared.                                                                                                                        |
| `bench.mjs`              | Wall time + memory per lifecycle phase (parse / resolve / formats / run / prepareResults), median over N runs, GC time, worker-sampled phase RSS and process peak RSS. **The primary harness.** |
| `bench-attrib.mjs`       | Splits the `run` phase further: nimma compile vs traversal vs rule functions vs `processTargetResults`.                                                                                         |
| `mem-attrib.mjs`         | Retained size of each big structure, by dropping its only reference and forcing GC. Answers "AST vs data graph vs resolved graph".                                                              |
| `heap-top.mjs`           | Heap snapshot → top constructors by aggregate shallow size.                                                                                                                                     |
| `prof-top.mjs`           | Summarises a `--cpu-prof` `.cpuprofile` into top self-time functions, no DevTools needed.                                                                                                       |
| `verify-equivalence.mjs` | sha256 over normalised findings. **Run before/after every perf change** — output must not move.                                                                                                 |
| `fetch-corpora.mjs`      | Selects real APIs.guru documents by size band and writes a `SHA256SUMS` manifest. Existing files with prior manifest entries are verified unless `--refresh` is explicit.                       |
| `sweep.mjs`              | Runs each real document in an isolated child process and records phase time, process peak RSS, structure and validator-compile counts.                                                          |
| `loadtest.mjs`           | Library-API throughput, latency and long-lived retention. `--cache shared/per-run` and `--distinct` make resolver-cache lifetime measurable.                                                    |

## Reading the memory output

These measurements answer different questions and must not be substituted for
one another:

- **Peak RSS** is the maximum absolute resident set of the process. It includes
  live JS objects, unused V8 heap capacity, generated validator code and native
  allocations.
- **Phase RSS growth** is the maximum RSS sampled within a phase minus RSS at the
  phase boundary. It locates allocation pressure, but it is neither retained heap
  nor additive across phases.
- **Post-GC live heap** is `heapUsed` after an explicit full GC. It estimates
  retained JavaScript objects; RSS minus this number is not itself a live-object
  measurement.
- The retention load test reports **final process RSS** when its worker thread
  stops. `process.memoryUsage().rss()` is process-wide for worker threads, and the
  value is sampled only at stage end, so it is not a per-worker or intra-request
  peak.

The main lint phases block the event loop, so a timer on that thread misses their
peaks. `bench.mjs` therefore samples process-wide RSS every 2ms from a worker
thread. Provenance collection records the exact commit plus hashes of porcelain
status, the binary tracked diff, untracked file contents, the loaded package
`dist` tree, installed patched dependencies, lockfile, Node executable/argv and
`NODE_OPTIONS`, working directory and allocator preload. Git is sampled until two
consecutive captures match (at most three attempts); collection fails rather than
silently publishing null metadata. Every long-running harness also requires its
executable fingerprints to match again at the end.

`bench.mjs` hashes the raw document bytes. `sweep.mjs` additionally requires each
child to report the same input byte count and hash the parent selected.
`loadtest.mjs` records every corpus byte count/hash and checks the files after
every stage; band subruns must match the parent's executable provenance. The
load-test check detects persistent edits but deliberately does not hash inside a
timed request, so a file changed and restored entirely within one stage is not
detectable without perturbing throughput. Preserve provenance with published
results; a number from a dirty tree is evidence for that exact tree, not HEAD.

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

| phase       | before         | after         |                                |
| ----------- | -------------- | ------------- | ------------------------------ |
| parse       | 3,666 ms       | 3,181 ms      | —                              |
| **resolve** | **123,219 ms** | **7,696 ms**  | **16.0x**                      |
| run         | 7,611 ms       | 5,004 ms      | 1.5x                           |
| **TOTAL**   | **134,499 ms** | **15,883 ms** | **8.5x**                       |
| peak RSS    | 1,733 MB       | 1,640 MB      | −93MB (not the primary effect) |

For reference, aliasing `resolved` to `unresolved` (i.e. the ceiling if `$ref`
resolution were virtualised rather than materialised) gives 6.1s / 890MB.

Output is byte-identical (`verify-equivalence.mjs`, 21,648-finding corpus) and the
full suite passes (260 core + 762 rulesets tests).

> Absolute times were captured on a loaded machine (load avg ~11 on 32 cores), so
> they run high; the before/after pair was measured back to back under identical
> conditions, so the **ratios** are the meaningful figures. Re-run both sides
> yourself rather than trusting the absolute milliseconds.

### The original three quadratic algorithms

1. **`dependency-graph@0.11.0` `addDependency`** — scans the edge array with
   `Array.indexOf` before every insert. With `$ref` fan-in, `incomingEdges` for a
   shared schema grows to O(N), making edge insertion **O(E²)**. `overallOrder`'s
   circular pass has the same problem via `result.indexOf(node)`. The patch uses
   one outgoing-edge `Set` per source node and keeps it synchronised across edge
   removal, node removal/re-addition and clone.
   Patched in `patches/dependency-graph+0.11.0.patch`. **123s → ~14s**
   _Still present in dependency-graph 1.0.0 — worth reporting upstream._

2. **`@stoplight/json-ref-resolver@3.1.6` `runner.js`** — calls
   `pointerStemGraph.dependenciesOf(pointer)` (a graph DFS) _inside_ the
   per-dependant loop, where it is loop-invariant.
   Patched in `patches/@stoplight+json-ref-resolver+3.1.6.patch`. **~14s → 7.7s**

3. **operationId/messageId uniqueness rules** — collected seen ids in an `Array`
   and tested membership with `.includes()`, i.e. **O(n²)** over operations.
   `oasOpIdUnique` alone was 27.7% of total CPU once the resolver was fixed.
   Fixed in source (`Set`). **`run` phase 7.6s → 5.0s** (and 5.7s → 2.9s with resolution virtualised)

### Memory decomposition (historical pre-AST-shrink probe, 20.5MB document)

| component      | heap                           |                                               |
| -------------- | ------------------------------ | --------------------------------------------- |
| source string  | 21MB                           |                                               |
| **YAML AST**   | **362MB**                      | retained only to answer `getRangeForJsonPath` |
| lineMap        | 7MB                            |                                               |
| data graph     | 146MB                          | ~7x source — the real payload                 |
| resolved graph | +158MB live / +1.2GB transient | immer copy-on-write churn                     |

The three resolver/rule fixes are **CPU-only**. A later node-layout patch removed
an empty `errors` array and unread `rawValue` from each YAML AST node, and declared
the two scalar flags in-object. On real APIs.guru documents, post-GC AST heap fell
**333.6MB → 207.2MB** for MS Graph and **109.3MB → 67.2MB** for GitHub (~38%).
In the isolated A/B, process peak RSS fell 1,590MB → 1,458MB and
1,047MB → 922MB respectively; parse time was neutral to slightly better. The AST
is smaller, but retaining it only for range lookup remains an architectural cost.
Materialising the resolved graph still costs memory and ~2x on the `run` phase
because rules traverse the inlined duplicates.

## Round 1.5: validators and lint memory

`allErrors: true` made the generated standalone OAS/Arazzo validators repeatedly
copy their whole accumulator with `concat`. Code generation now rewrites all 606
sites (587 bare validators and 19 dotted members) to one indexed append helper.
The first error array is copied with `slice()` to preserve non-aliasing and error
order, and generation fails if any matching error-array concat remains.

| errors |  concat | indexed append |
| -----: | ------: | -------------: |
| 20,000 |   207ms |          107ms |
| 40,000 |   994ms |          203ms |
| 80,000 | 3,509ms |          465ms |

At 80k errors, peak RSS fell **137MB → 37MB**. An interim implementation used
`push.apply`, which is linear but still spreads one function argument per error;
the current regression returns all 130,001 errors in order where that version
threw `RangeError`.

On real `github.com@1.1.4` (8.4MB), worker-thread sampling attributed the
pre-structural-cache RSS growth as follows:

| phase   | sampled RSS growth |
| ------- | -----------------: |
| parse   |             +253MB |
| resolve |             +138MB |
| lint    |         **+572MB** |

Forced-GC attribution showed why RSS and live heap must stay separate: an empty
ruleset added approximately 0MB; all rules retained **112MB live heap** while RSS
grew **521MB**. `oas3-valid-media-example` accounted for **98MB live** and
**482–486MB RSS growth** in isolated runs. Most of that phase's RSS was therefore
transient allocation/V8 capacity rather than retained JS objects.

The first fix cached `oasExample`'s prepared schema per source node, cutting
GitHub's Ajv compiles **122,324 → 5,206**, total time **20.7s → 8.2s**, and peak
RSS **2,184MB → 1,033MB**. Structural reuse then collapsed identical inline
schemas: **5,206 → 1,691 compiles**, lint **6,418ms → 5,224ms**, lint-phase RSS
growth **572MB → 335MB**, and peak RSS **1,033MB → 905MB**. MS Graph peak RSS
fell **1,590MB → 1,445MB**. Those structural-cache A/B figures are provenance for
commit `6210b457`.

The follow-up restricts structural keys to recursively verified JSON data,
preserves identity fallback for unsafe/exotic values, and separates safe OAS
example schemas (`code.optimize: 0`) from registry/ref/anchor schemas. Against
the saved pre-follow-up Node v26.7.0 baseline, three isolated one-run
lifecycle-parity processes measured:

| metric           | baseline | final median | change |
| ---------------- | -------: | -----------: | -----: |
| total            |  8,686ms |      5,688ms | −34.5% |
| lint/run         |  6,846ms |      3,810ms | −44.3% |
| process peak RSS |    803MB |        550MB | −31.5% |

Final peak samples were 544/550/702MB, demonstrating why one V8 high-water mark
is not deterministic. A separate child-process sweep measured lint
**6,458ms → 4,078ms**, total **8,352ms → 5,934ms**, and peak RSS
**810.3MB → 639.7MB**; ajv compile calls stayed at 1,654. These numbers describe
the complete hardened worktree (including validator-codegen changes), not cache
hardening in isolation. All five final equivalence anchors were byte-identical:
GitHub 634 findings, MS Graph 9,957, OAS 2 22, OAS 3.1 10 and AsyncAPI 2 7.

## Long-lived resolver cache

One `Spectral` instance intentionally shares resolver caches across calls, which
can be useful when documents reuse remotes. It also pins every distinct root and
remote unless the caller defines a lifetime. `Spectral.clearCache()` now provides
that boundary, and the CLI calls it after each input because it keeps diagnostics,
not resolved documents.

One worker linted 400 distinct documents from `corpora/small` on Node v26.7.0:

```bash
node scripts/bench/loadtest.mjs --profile retention --distinct --cache shared \
  --json /tmp/retention-shared.json
node scripts/bench/loadtest.mjs --profile retention --distinct --cache per-run \
  --json /tmp/retention-per-run.json
```

| cache policy  |    wall | findings | errors | final process RSS |
| ------------- | ------: | -------: | -----: | ----------------: |
| shared        | 36.879s |   22,814 |      0 |           1,837MB |
| per-run clear | 36.856s |   22,814 |      0 |             453MB |

The output and time were equivalent in this corpus; final RSS was 4.1x lower.
This is a 400-distinct retention result, not evidence that clearing is always free
when requests intentionally reuse the same remote documents.

Each load-test stage warms the same worker pool it measures with at least ten
requests and at least one request per worker. Warmups use identical resolver
cleanup in shared/per-run modes, then all worker caches are cleared before timing;
`per-run` additionally clears after every measured request. Resolution is offline
by default. `--allow-remote` is explicit and requires a positive
`--max-stage-s`, which is both a preflight estimate limit and a real warmup/batch
watchdog. Any warmup or measured exception makes the command fail, while measured
error details are retained in JSON.

## Round 2: the result pipeline

The corpus above produces **zero findings**, which makes it blind to everything
downstream of a rule match. `gen-synthetic.mjs --dirty` strips descriptions and
operationIds so the same document yields ~50k findings, and that exposed two more
wins. Back-to-back A/B on a 21.3MB `--dirty` corpus, two passes:

| config               | run phase            | total                  | peak RSS |
| -------------------- | -------------------- | ---------------------- | -------- |
| after round 1        | 19,202 / 20,050 ms   | 31,369 / 32,670 ms     | 2,220 MB |
| + AST key index      | 5,811 / 5,709 ms     | 18,198 / 17,684 ms     | 2,222 MB |
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
- Remote load testing is opt-in because network timing is nondeterministic. When
  `--allow-remote` is used, external response bytes are not part of the corpus
  manifest; archive them separately before promoting a result.
- `patches/` only fixes this repository's install. Patch application for
  `dependency-graph@0.11.0` was verified against a pristine package tarball, but
  `patch-package` generation currently fails under Yarn 3 because it invokes the
  unsupported `yarn --ignore-scripts`. More importantly, downstream consumers of
  published `@stoplight/spectral-*` packages do not apply the repository's root
  patches and still receive unpatched transitive dependencies. Upstream, fork, or
  bundle those fixes before treating the package-publication risk as closed.
