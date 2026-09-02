# Spectral performance roadmap

Goal: lint a ~22MB OpenAPI document in seconds, not minutes, with peak RSS in the
low hundreds of MB rather than 1–2GB.

Every claim here is measured on this branch. Absolute times come from a loaded
workstation (32 cores, load 5–11), so treat **ratios** as the result and re-run
both sides yourself. Corpora are real documents from APIs.guru unless marked
synthetic — see [scripts/bench/README.md](scripts/bench/README.md).

Memory columns are deliberately named. **Peak RSS** is an absolute, process-wide
high-water mark. **Phase RSS growth** is the highest RSS sampled during one phase
minus RSS at that phase's boundary; phase deltas are not retained heap and are not
additive. **Post-GC live heap** is `heapUsed` after an explicit full GC. RSS also
includes V8 capacity, generated code and native allocations, so RSS minus live
heap is transient/capacity overhead, not a second retained-heap measurement.

`bench.mjs` samples process-wide RSS every 2ms from a worker thread because parse,
resolve and lint block the main event loop. Its JSON records exact Git status,
tracked-diff and untracked-content hashes, the loaded `dist` tree, installed
patched dependencies, document and lockfile hashes, Node executable/flags,
working directory, OS, CPU, memory and allocator preload. Git state must stabilize
across two consecutive captures, and executable provenance must still match after
the run. Keep that provenance with any number promoted into this roadmap.

## Where the time actually goes

Reference snapshot after the `oasExample` fix and before the structural validator
cache A/B below, `oas` ruleset, Node v24.5.0:

| document            |   size | $ref/KB | examples | parse | resolve |      lint | peak RSS |
| ------------------- | -----: | ------: | -------: | ----: | ------: | --------: | -------: |
| microsoft.com:graph | 24.6MB |    2.09 |      584 |  1.7s |    3.9s | **28.7s** |  1,591MB |
| github.com          |  8.4MB |    0.80 |    4,354 |  0.6s |    0.9s |  **6.7s** |  1,033MB |
| stripe.com          |  3.5MB |    0.67 |        2 |  0.2s |    0.5s |      1.9s |    358MB |
| kubernetes.io       |  3.2MB |    0.84 |        8 |  0.2s |    0.3s |      1.1s |    343MB |

**Lint dominates on every real document** — 85–93% of wall clock. `$ref`
resolution is 5–12%. An earlier synthetic corpus made resolution look like 51%;
it was 4–10x more ref-dense than any real spec. Do not plan against synthetics.

**Three** regimes, and a document can be in more than one. Which regime a document
is in decides which fix helps it; nothing here generalises across all three:

- **Ref-dense** (MS Graph, 52,610 refs): traversal-bound, and its peak RSS is
  reached during **resolve** — lint adds ~0MB. nimma `_traverse` is **42%** of wall
  clock, because $ref inlining makes the resolved graph walk the same shared schema
  once per reference.
- **Example-dense** (GitHub, 4,354 examples): peak is reached during **lint**,
  driven by ajv schema compilation. Largely fixed below.
- **Parse-bound** (stripe, kubernetes): peak is reached during **parse**; lint adds
  0.5–1.2x source. Nothing in the lint-phase work moves these documents.

A correction worth keeping: "peak RSS is reached inside the lint phase" was
generalised from GitHub alone and is **false** for the other two regimes.

### Current state (measured on HEAD, Node v24.5.0, after all landed work)

| document            |   size | parse | resolve |    lint |  total | peak RSS |
| ------------------- | -----: | ----: | ------: | ------: | -----: | -------: |
| microsoft.com:graph | 24.6MB | 1.7s  |    4.0s |   31.2s | 37.0s  |  1,327MB |
| github.com          |  8.4MB | 0.6s  |    1.0s |    4.1s |  5.8s  |    656MB |
| stripe.com          |  3.5MB | 0.2s  |    0.5s |    2.2s |  2.9s  |    353MB |
| kubernetes.io       |  3.2MB | 0.2s  |    0.4s |    1.2s |  1.7s  |    331MB |

---

## Done

- [x] **`dependency-graph` `addDependency` O(E²)** — `Array.indexOf` on the edge
      list before every insert. The patch now keeps one `Set` per source node and
      synchronises it across remove, clone and node lifecycle operations.
      `patches/dependency-graph+0.11.0.patch`.
      Resolve 123s → 14s on a ref-dense synthetic. _(Still present in
      dependency-graph 1.0.0 — worth an upstream issue.)_
- [x] **`json-ref-resolver` loop-invariant DFS** — `dependenciesOf(pointer)`
      recomputed per dependant. `patches/@stoplight+json-ref-resolver+3.1.6.patch`.
      Resolve 14s → 7.7s.
- [x] **`Set` for id-uniqueness** — `seenIds` was an Array with `.includes()`,
      O(n²), in `oasOpIdUnique` + 2 asyncapi rules. Run phase −35%.
- [x] **YAML map key index** — `findNodeAtPath` rebuilt `getMappings()` and
      linear-scanned per path segment per finding. `patches/@stoplight+yaml+4.3.0.patch`.
      Run phase 19.6s → 5.8s (3.4x) on a 50k-finding synthetic.
- [x] **`nimma/legacy` → modern build** — Babel-lowered private fields cost a
      pair of WeakMap lookups per traversal step; `engines` already requires
      Node ≥16.20. One line. Run phase 5.8s → 4.4s.
- [x] **ajv error accumulation O(E²)** — 606 generated
      `acc.concat(sub.errors)` sites under `allErrors: true` (587 direct calls and
      19 dotted validator members). Codegen now uses one indexed append helper,
      copies the first error array, and fails if any matching error-array concat
      survives. 80k errors: 3,509ms → 465ms, 137MB → 37MB. Unlike the interim
      `push.apply` version, it also returns all 130,001 errors in the argument-limit
      regression instead of throwing `RangeError`; exact error order is asserted.
- [x] **Shrink YAML AST nodes** — removed an empty `errors` array and unread
      `rawValue` from every node, while declaring the scalar flags in-object.
      Post-GC AST heap: MS Graph **333.6MB → 207.2MB** and GitHub
      **109.3MB → 67.2MB** (~38%); end-to-end peak RSS fell 1,590MB → 1,458MB
      and 1,047MB → 922MB in that isolated A/B. Findings and equivalence hashes
      were unchanged.
- [x] **`oasExample` schema cache** — `JSON.parse(JSON.stringify(...))` minted a
      fresh identity per call, so the identity-keyed validator WeakMap never hit
      and ajv recompiled every time (and retained it in a strong Map).
      github.com: **122,324 → 5,206 compiles, 20.7s → 8.2s, 2,184MB → 1,033MB**.
- [x] **Structural compiled-validator reuse** — repeated inline schema shapes
      still had different identities. On the measured implementation, GitHub
      compiled **5,206 → 1,691** validators, lint took **6,418ms → 5,224ms**,
      lint-phase RSS growth fell **572MB → 335MB**, and peak RSS fell
      **1,033MB → 905MB**; MS Graph peak RSS fell **1,590MB → 1,445MB**.
      The hardened follow-up only uses structural keys for recursively verified
      JSON data and falls back to identity for accessors, symbols, exotic
      prototypes, cycles and other unsafe values. It also keeps registry schemas
      with `$id`, `$ref` or anchors in the optimized ajv pool while safe OAS
      example schemas use a separate `code.optimize: 0` pool. Against the saved
      pre-follow-up Node v26.7.0 baseline, three isolated lifecycle-parity runs
      had median total **8,686ms → 5,688ms**, lint/run **6,846ms → 3,810ms**, and
      peak RSS **803MB → 550MB**. Individual final peaks were 544/550/702MB, so
      the median is representative, not a claim that V8's high-water mark is
      deterministic. An independent child-process sweep measured lint
      **6,458ms → 4,078ms** and peak RSS **810.3MB → 639.7MB**, with ajv compiles
      unchanged at 1,654. These follow-up figures cover the complete hardened
      worktree, including validator-codegen changes; they do not attribute the
      whole delta to cache hardening alone.
- [x] **Bound resolver-cache lifetime in the CLI** — `Spectral.clearCache()`
      purges both resolver caches, and the CLI calls it after each input document.
      A one-worker, 400-distinct-document library run produced the same 22,814
      findings with zero errors and essentially identical wall time
      (36.879s shared vs 36.856s per-run), while **final process RSS** was
      **1,837MB shared vs 453MB per-run**. This is a stage-end RSS measurement,
      not a per-worker or intra-request peak; library users retain the choice to
      share caches when reuse is intentional.
- [x] **Remove argument-count cliffs in result handling** — CLI accumulation and
      formatter reducers use loops instead of spread. Stylish, pretty, HTML and
      Markdown outputs retain their hashes at 100k findings and complete at 130k,
      where the previous code threw `RangeError`.
- [x] **Fix the equivalence gate** — it built its `Document` without a `source`,
      so `findAssociatedItemForPath` returned `null` before the refMap walk: 0 of
      13,632 calls exercised it. The CLI always passes a source. Also now hashes
      `source`, `documentationUrl`, and result _ordering_.
- [x] **Real corpora** — `scripts/bench/fetch-corpora.mjs` + committed size index
      over APIs.guru's 3,955 documents.
- [x] **Fix the dependency-graph edge index on removal** — our own `_oidx` was
      never updated by `removeDependency`/`removeNode`, so after any removal the
      index claimed edges the arrays no longer had and a re-added edge was silently
      dropped. json-ref-resolver does not remove edges during a normal resolve, so
      it never surfaced, but the patch is ours and so was the bug. Now a
      `Map<from, Set<to>>` maintained by every mutation, with a regression test.
- [x] **Right-size the key-order array** in parsed YAML mappings —
      ordered-object-literal grows its order array in V8 capacity steps (16, 40,
      76, ...) while mappings average ~3.6 keys, so the store was ~4x the data and
      live for as long as the data graph.

      These two were measured **together**: peak RSS 1,360MB → 1,327MB on MS Graph
      (−2.4%), 663MB → 656MB on GitHub (−1.1%), 332MB → 331MB on kubernetes.
      Earlier per-item estimates of 88MB and 22.8MB were **structure-size**
      measurements taken destructively; they are not peak-RSS deltas and should not
      be quoted as such. The correctness fix is the reason to keep the first one.

Cumulative on a ref-dense 20MB synthetic: **134.5s → 15.9s**. On real
github.com@1.1.4, the `oasExample` fix moved **20.7s → 8.2s** and
**2,184MB → 1,033MB**; structural reuse then moved the lint phase
**6,418ms → 5,224ms** and peak RSS **1,033MB → 905MB** in its isolated A/B. The
hardened follow-up's lifecycle-parity median is now **5,688ms total / 3,810ms
run / 550MB peak RSS**. Equivalence output remained byte-identical on GitHub,
MS Graph, OAS 2, OAS 3.1 and AsyncAPI 2.

---

## Measurement rules learned the hard way

Three claims in this document have had to be walked back for the same class of
error. Before promoting a number here:

1. **A structure's size is not a peak-RSS delta.** Destructively dropping a
   structure and forcing GC tells you what it retains, not what the process
   high-water mark would have been without it. Quote both, separately.
2. **Do not generalise from one document.** "Peak is inside lint" (GitHub-only),
   "resolve is 51% of wall clock" (a synthetic 4–10x too ref-dense), and the −53%
   heap-cap figure were all true of exactly one corpus.
3. **Re-measure after every landed change.** The heap-cap lever shrank from −53%
   to −12% on GitHub purely because an earlier fix removed the churn it was
   reclaiming. Stale levers look like available wins.
4. **Sample RSS from a worker thread.** Parse, resolve and lint block the main
   event loop, so a `setInterval` sampler there records nothing during the phases
   that matter.

## Next — measurement (do first, it re-ranks everything below)

- [ ] **Benchmark the user's actual 22MB document.** Everything is calibrated on
      other people's specs. Record: size, `$ref`/KB, example count, phase split,
      peak RSS, `ajv.compile` count, findings count. The ref/example ratio decides
      which of the two branches below matters.
- [ ] **Sweep the full APIs.guru corpus** (3,955 docs) for outliers — documents
      whose time or RSS is disproportionate to size. Cheap, parallel, and the best
      way to find the next cliff without guessing.
- [ ] **Finish live-vs-transient attribution for resolution.** GitHub lint is now
      settled: with no rules it added ~0MB; with all rules it retained 112MB of
      post-GC heap while RSS grew 521MB. `oas3-valid-media-example` alone accounted
      for 98MB live / 482–486MB RSS growth before structural reuse. The remaining
      open case is the synthetic resolver: only ~944MB of a 2,142MB peak was live,
      while `resolve()` retained just +191MB. Confirm the V8-space attribution
      before scheduling any chunked-Immer work.
- [ ] **Add a CI perf gate** on 3–4 real documents with a ratio threshold, so none
      of the above regresses silently.
- [x] **Re-measure the V8 heap-cap lever on HEAD.** It is regime-split, and the
      previously quoted −53% is stale: the structural validator cache removed the
      ajv churn V8 was growing the heap to absorb.

      | document            | default | capped     |   RSS | time |
      | ------------------- | ------: | ---------- | ----: | ---: |
      | github.com          |   654MB | 576MB @512 |  −12% | +18% |
      | microsoft.com:graph | 1,360MB | 909MB @768 |  −33% | +20% |

      Findings identical at every cap. Worth taking on ref-dense documents, a poor
      trade on example-dense ones.
- [ ] **Explain peak-RSS variance under equivalent runs.** Three isolated final
      GitHub runs produced 544/550/702MB while findings, executable provenance
      and input bytes were identical. CPU time was much tighter. Capture V8 space
      and GC scheduling alongside RSS before treating a single high-water mark as
      a regression.

## Next — CPU

- [ ] **Identity dedup on the resolved graph** _(biggest remaining lever)_.
      nimma `_traverse` is 42% of MS Graph's wall clock because $ref inlining
      makes shared schemas traversed once per reference. Redocly's
      `seenNodesPerType` walks distinct nodes once. Needs care: findings must
      still report every referencing path, not just the first.
- [ ] **Narrow `$..[description,title]`** — one expression produced 42% of matches
      on a synthetic. Check the real distribution first; identity dedup may
      subsume it.
- [ ] **Lazy `MessageVars.value`** — computed via a lodash `get` per finding and
      read by **zero** shipped rules (`grep '{{value}}' packages/rulesets/src` is
      empty). Must stay available for custom rulesets, so make it a getter.
- [ ] **Hoist `Replacer`'s `expr-eval` parser** to module scope — currently
      rebuilt, with its whole function table, twice per finding.
- [ ] **Memoise `getClosestJsonPath`** in `documentInventory.ts` — computed at
      :95 and recomputed at :101.

## Next — memory

- [ ] **Stop retaining the YAML AST** — the node-layout patch cut this structure
      ~38%, but it still retains 207.2MB on MS Graph and 67.2MB on GitHub solely to
      answer range lookups. Replace it with a compact position side-table, or
      re-derive ranges lazily; this still needs a design.
- [ ] **`Document` pins the raw input string forever** (`document.ts:34`) with no
      reader after `parser.parse()`. ~21MB, one line — but Stage-C range work will
      want the source, so land them together.
- [ ] **`preserveKeyOrder`** — on real documents the ordering Proxy costs **59.1MB
      on MS Graph (40% of the data graph)** and 20.0MB on GitHub. The often-quoted
      "~363MB and 1.28x" came from a synthetic and should not be reused.
      JS already preserves insertion order for string keys; only
      integer-like keys (response status codes) are affected. Needs to be an
      opt-out, not a silent flip. **Do not** try selective wrapping — measured, and
      it makes `run` _worse_ (12.8s → 16.4s) because mixed shapes turn rule
      property access megamorphic.

## Next — robustness

- [ ] **`traverseObjUntilRef` mutates its argument** (`runtime/src/utils/refs.ts`)
      and `missingPropertyPath` depends on that side effect. A hazard for any
      refactor or reimplementation; document or fix deliberately.

- [ ] **Remove root-only patch publication risk.** `patch-package` application was
      verified against a pristine `dependency-graph@0.11.0` tarball, but patch
      generation is broken under this Yarn 3 setup (`yarn --ignore-scripts` is not
      supported), and published `@stoplight/spectral-*` packages do not apply this
      repository's root `patches/` to downstream installs. Upstream, fork, or
      bundle the dependency fixes before calling them shipped to package users.

## Deferred — Rust core

- [ ] **Revisit only after the measurement block above.** The case rests on
      eliminating materialisation (AST + resolved graph), not on rule-function CPU.
      Boundary (b) — per-match FFI callbacks — is disqualified by measured callback
      volume. Boundary (c) — parse + index + resolve-as-edges + query in Rust — is
      the only defensible one. Blockers to answer first: `given` expressions contain
      JS that no RFC 9535 crate evaluates (21 of 132 are JS-only), and ajv-errors
      `errorMessage` parity (85 uses) has no Rust equivalent. `vacuum` (Go) proves
      the architecture but not the compatibility surface.
