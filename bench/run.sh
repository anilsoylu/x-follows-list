#!/usr/bin/env bash
# XFL perf bench — repeatable end-to-end harness on a real Chrome DOM.
# Usage:   ./bench/run.sh results-before           (arg = output basename)
# Writes:  bench/<arg>.json (artifact; the html dump is not needed)
# Flow: the bench page POSTs its JSON to the local save server, so Chrome
# exit timing does not matter (unlike --dump-dom, which fires at load).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8931
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="${1:?usage: run.sh results-before|results-after}"

node --check bench/bench.js && node --check bench/chrome-stub.js

TMPD=$(mktemp -d /tmp/xfl-chrome-XXXX)
rm -f "bench/$OUT.json"
python3 bench/server.py "$PORT" >/dev/null 2>&1 &
SRV=$!
sleep 0.6

"$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --disable-extensions --user-data-dir="$TMPD" \
  "http://127.0.0.1:$PORT/bench/bench.html?out=$OUT" >/dev/null 2>&1 &
CHROME_PID=$!

trap 'kill $SRV 2>/dev/null || true; kill $CHROME_PID 2>/dev/null || true; rm -rf "$TMPD"' EXIT

# Wait until the bench page POSTs its results (max 60s)
for _ in $(seq 1 120); do
  [ -f "bench/$OUT.json" ] && break
  sleep 0.5
done

if [ ! -f "bench/$OUT.json" ]; then
  echo "FAILED: bench did not POST results in time" >&2
  exit 1
fi

python3 - "$OUT" <<'PY'
import json, pathlib, sys
base = sys.argv[1]
data = json.loads(pathlib.Path(f'bench/{base}.json').read_text())
print(f'bench/{base}.json written — ALL_PASS={data["checks"]["all_pass"]}  boot={data["boot_ms"]}ms')
for k, s in data['scenarios'].items():
    if 'mean' in s and 'ticks' in s:
        print(f'  {k}: ticks={s["ticks"]}  mean={s["mean"]:.2f}ms  p50={s["p50"]:.2f}ms  p95={s["p95"]:.2f}ms')
    elif 'dispatch_mean' in s:
        print(f'  {k}: dispatch_mean={s["dispatch_mean"]:.3f}ms  (frame-inclusive burst_mean={s["burst_mean"]:.2f}ms)')
    elif 'dispatch_ms' in s:
        print(f'  {k}: dispatch_ms={s["dispatch_ms"]:.3f}ms  (300 events, frame wait excluded)')
    elif 'total_ms' in s:
        print(f'  {k}: total={s["total_ms"]}ms')
PY
