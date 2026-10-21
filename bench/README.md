# XFL perf bench
Repeatable end-to-end harness (AGENTS.md compliant: E2E-only, artifact-producing).

## How to repeat
```bash
npm run check                 # node --check ×3 + manifest JSON parse
./bench/run.sh results-before # Chrome DOM + real content.js → bench/results-before.json
./bench/run.sh results-after  # → bench/results-after.json
```
Requires Chrome at `/Applications` (headless=new) and python3. The bench page loads the REAL `content.js` via a `chrome.*` stub (`chrome-stub.js`), intercepts only the 150 ms scan debounce (`setTimeout(scan, 150)` → synchronous) so each MutationObserver-driven tick is timing-isolated; all other timings stay real. Scenario `?out=<name>` names the artifact; the page POSTs its JSON to a local save server (`server.py`) so Chrome exit timing never truncates a run.

## Measured (2026-10-21, Chrome 156.0.8078.47, M-series macOS, HEAD=ORIG before, WORK=OPT after)

| Scenario | before mean | after mean | Δ |
|---|---|---|---|
| **A** — scroll churn: append row + scan, list closed (120 ticks; simülates scrolling the /following page) | 0.53 ms (p95 1.10) | 0.17 ms (p95 0.30) | **−68% mean, −73% p95** |
| **B** — list panel OPEN, state unchanged, pure DOM churn (60 ticks) | 1.96 ms | 0.22 ms | **−89%** |
| **B2** — list panel OPEN, visible names churning → rebuild when data really changes (60 ticks) | 2.05 ms | 0.40 ms | **−80%** |
| **C** — hover: 30 mousemove over a row, dispatch-only mean | 0.700 ms | 0.033 ms | **−95%** |
| **C2** — hover throttle proof: 300 mousemove in one burst, dispatch-only | 4.50 ms | 0.10 ms | **−98%** |
| **D** — getStatus ×200 (popup's 700 ms ticker) | 0.5 ms | 0.4 ms | ~flat |

Frame-inclusive burst times (C ≈ 20 ms both sides) are dominated by the two `requestAnimationFrame` waits themselves and are NOT comparable — the dispatch-only numbers above are the CPU signal.

`boot_ms` (content script parse/eval) showed impossible poor re-run repeatability on both sides (9–19 ms) — parse cost of ~45 KB is noise-level; treated as unchanged (the content script was already passive/highly idling at page load).

## Parity asserts (inside both artifacts)
- `owner_path = bench` (owner resolution on a `/handle/following` URL)
- `nfCount = 135` == expected (15 seeded non-followers + 120 appended)
- `list_rows = 135` (panel rows match nfCount)
- `marked_nf = 135` (outline marks on-screen cells)
- `ALL_PASS = True` in both runs — no behavioral drift from the optimization

## What changed to get these numbers (content.js)
1. Scans no longer call `getBoundingClientRect` per row (`yOf` sort → document order removed; `yOf` kept only for «Next» jumping).
2. `renderList` skips the DOM rebuild when the row/name/ignore signature is unchanged (invalidated when panel closes or data changes).
3. `paint()` and `widgetRefs()` are signature/cached — no more 8 `qSA` per scan.
4. `mousemove` handler is rAF-throttled to run once per frame (listener registration unchanged).
5. Scans find `UserCell`+unfollow rows in one query (per-cell extra queries eliminated).

Known residual risk to verify live (cannot be automated here): «Next»/jump ordering still assumes X renders rows in DOM order. If X ever emits rows out of visual DOM order, jump targeting may go slightly out of order until the next scan.
