# Spectral performance roadmap

Goal: lint a ~22MB OpenAPI document in seconds, not minutes, with peak RSS in the
low hundreds of MB rather than 1–2GB.

Every claim here is measured on this branch. Absolute times come from a loaded
workstation (32 cores, load 5–11), so treat **ratios** as the result and re-run
both sides yourself. Corpora are real documents from APIs.guru unless marked
synthetic — see [scripts/bench/README.md](scripts/bench/README.md).

## Where the time actually goes

Measured after all shipped fixes, `oas` ruleset, Node v24.5.0:

| document | size | $ref/KB | examples | parse | resolve | lint | peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|
| microsoft.com:graph | 24.6MB | 2.09 | 584 | 1.7s | 3.9s | **28.7s** | 1,591MB |
| github.com | 8.4MB | 0.80 | 4,354 | 0.6s | 0.9s | **6.7s** | 1,033MB |
| stripe.com | 3.5MB | 0.67 | 2 | 0.2s | 0.5s | 1.9s | 358MB |
| kubernetes.io | 3.2MB | 0.84 | 8 | 0.2s | 0.3s | 1.1s | 343MB |

**Lint dominates on every real document** — 85–93% of wall clock. `$ref`
resolution is 5–12%. An earlier synthetic corpus made resolution look like 51%;
it was 4–10x more ref-dense than any real spec. Do not plan against synthetics.

Two regimes, and a document can be in both:
- **Ref-dense** (MS Graph, 52,610 refs): traversal-bound. nimma `_traverse` is
  **42%** of wall clock, because $ref inlining makes the resolved graph walk the
  same shared schema once per reference.
- **Example-dense** (GitHub, 4,354 examples): was validator-bound. Fixed below.

---

## Done

- [x] **`dependency-graph` `addDependency` O(E²)** — `Array.indexOf` on the edge
      list before every insert. `patches/dependency-graph+0.11.0.patch`.
      Resolve 123s → 14s on a ref-dense synthetic. *(Still present in
      dependency-graph 1.0.0 — worth an upstream issue.)*
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
- [x] **ajv error accumulation O(E²)** — 587 generated `acc.concat(sub.errors)`
      sites under `allErrors: true`. Rewritten to push during codegen, with a
      build-failing assertion. 80k errors: 3,509ms → 465ms, 137MB → 37MB.
- [x] **`oasExample` schema cache** — `JSON.parse(JSON.stringify(...))` minted a
      fresh identity per call, so the identity-keyed validator WeakMap never hit
      and ajv recompiled every time (and retained it in a strong Map).
      github.com: **122,324 → 5,206 compiles, 20.7s → 8.2s, 2,184MB → 1,033MB**.
- [x] **Fix the equivalence gate** — it built its `Document` without a `source`,
      so `findAssociatedItemForPath` returned `null` before the refMap walk: 0 of
      13,632 calls exercised it. The CLI always passes a source. Also now hashes
      `source`, `documentationUrl`, and result *ordering*.
- [x] **Real corpora** — `scripts/bench/fetch-corpora.mjs` + committed size index
      over APIs.guru's 3,955 documents.

Cumulative on a ref-dense 20MB synthetic: **134.5s → 15.9s**. On real
github.com@1.1.4: **20.7s → 8.2s and 2,184MB → 1,033MB**. Output byte-identical
throughout; 1,922 tests pass.

---

## Next — measurement (do first, it re-ranks everything below)

- [ ] **Benchmark the user's actual 22MB document.** Everything is calibrated on
      other people's specs. Record: size, `$ref`/KB, example count, phase split,
      peak RSS, `ajv.compile` count, findings count. The ref/example ratio decides
      which of the two branches below matters.
- [ ] **Sweep the full APIs.guru corpus** (3,955 docs) for outliers — documents
      whose time or RSS is disproportionate to size. Cheap, parallel, and the best
      way to find the next cliff without guessing.
- [ ] **Settle live-vs-transient memory.** Only ~944MB of a 2,142MB peak was live
      on the synthetic; the rest is allocator growth during `resolve()`, which
      retains just +191MB. V8 flag testing suggests those allocations are
      *promoted to old space*, not churning in the nursery — if so, "chunk the
      immer `produce()`" does nothing and should not be scheduled.
- [ ] **Add a CI perf gate** on 3–4 real documents with a ratio threshold, so none
      of the above regresses silently.

## Next — CPU

- [ ] **Identity dedup on the resolved graph** *(biggest remaining lever)*.
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

- [ ] **Stop retaining the YAML AST** — ~357MB live on a 20MB document, 2.5x the
      size of the data it describes, kept solely to answer range lookups for a few
      thousand findings. Replace with a compact position side-table, or re-derive
      ranges lazily. This is the single largest live-heap item and needs a design.
- [ ] **`Document` pins the raw input string forever** (`document.ts:34`) with no
      reader after `parser.parse()`. ~21MB, one line — but Stage-C range work will
      want the source, so land them together.
- [ ] **CLI `uriCache` leak** — retains every parsed document across files,
      O(files) instead of O(1).
- [ ] **`preserveKeyOrder`** — the ordering Proxy on every map costs ~363MB and
      1.28x. JS already preserves insertion order for string keys; only
      integer-like keys (response status codes) are affected. Needs to be an
      opt-out, not a silent flip. **Do not** try selective wrapping — measured, and
      it makes `run` *worse* (12.8s → 16.4s) because mixed shapes turn rule
      property access megamorphic.

## Next — robustness

- [ ] **Formatter `RangeError` above ~125k findings** — `Math.min(...results)`
      spreads the array. Four formatters plus `linter.ts:54`. A 22MB document hits
      this and loses the entire run after doing all the work.
- [ ] **`traverseObjUntilRef` mutates its argument** (`runtime/src/utils/refs.ts`)
      and `missingPropertyPath` depends on that side effect. A hazard for any
      refactor or reimplementation; document or fix deliberately.

## Deferred — Rust core

- [ ] **Revisit only after the measurement block above.** The case rests on
      eliminating materialisation (AST + resolved graph), not on rule-function CPU.
      Boundary (b) — per-match FFI callbacks — is disqualified by measured callback
      volume. Boundary (c) — parse + index + resolve-as-edges + query in Rust — is
      the only defensible one. Blockers to answer first: `given` expressions contain
      JS that no RFC 9535 crate evaluates (21 of 132 are JS-only), and ajv-errors
      `errorMessage` parity (85 uses) has no Rust equivalent. `vacuum` (Go) proves
      the architecture but not the compatibility surface.
