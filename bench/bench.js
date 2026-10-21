// XFL perf bench — drives the real content.js in a real DOM via the chrome stub.
// Measures per-UI-tick costs for the scenarios that matter on a live /following
// page: scroll churn (A), list panel steady state (B), list panel churn (B2),
// pointer movement (C), popup↔content message round-trip (D).
// Usage: served via bench/run.sh → headless Chrome → results-*.json.
(async function () {
  'use strict';
  const outName = new URLSearchParams(location.search).get('out') || 'results';
  const post = (name, body) => fetch(location.origin + '/bench/save?name=' + encodeURIComponent(name), { method: 'POST', body }).catch(() => {});
  try {

  const ST = window.__origSetTimeout;
  const sleep = (ms) => new Promise((r) => ST(r, ms));
  const stage = document.getElementById('stage');
  const nfRowsSel = '#xfl-list-body div#xfl-row:not(.xfl-igrow)';

  function sendMsg(msg) {
    return new Promise((res) => window.__xflListener(msg, {}, res));
  }

  // --- synthetic X-like row -------------------------------------------------
  let nextRowId = 0;
  function addRow(opts) {
    const { followsYou = false, name } = opts || {};
    const h = 'bench' + (nextRowId++);
    const row = document.createElement('div');
    row.setAttribute('data-testid', 'cellInnerDiv');
    const cell = document.createElement('div');
    cell.setAttribute('data-testid', 'UserCell');
    const av = document.createElement('div');
    av.setAttribute('data-testid', 'UserAvatar-Container-' + h);
    const btn = document.createElement('button');
    btn.setAttribute('data-testid', h + '-unfollow');
    const nm = document.createElement('span');
    nm.textContent = name || ('Bench ' + h);
    cell.append(av, btn, nm);
    if (followsYou) {
      const ind = document.createElement('div');
      ind.setAttribute('data-testid', 'userFollowIndicator');
      cell.append(ind);
    }
    row.append(cell);
    stage.append(row);
    return { row, cell, nm, h };
  }

  // One UI tick: mutate DOM, let the MutationObserver→debounced-scan finish
  // (stubbed to run synchronously), return elapsed wall ms.
  async function tick(mut) {
    const t0 = performance.now();
    mut();
    await null; // microtask checkpoint → MutationObserver callback + sync scan
    await null; // safety extra checkpoint
    return performance.now() - t0;
  }

  function stats(arr) {
    const a = [...arr].sort((x, y) => x - y);
    const p = (q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
    return {
      ticks: a.length,
      mean: +arr.reduce((s, v) => s + v, 0) / arr.length,
      p50: +p(0.5),
      p95: +p(0.95),
      max: +a[a.length - 1]
    };
  }
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(2) : v]));

  // --- run ------------------------------------------------------------------
  // Set the URL so pathMatch() sees /@handle/following
  history.pushState({}, '', '/bench/following');

  // Seed 30 rows (half "follows you") BEFORE start — mimics an already-loaded list
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push(addRow({ followsYou: i % 2 === 0 }));

  const startRes = await sendMsg({ type: 'xfl.start' });
  if (!startRes || !startRes.running) {
    document.getElementById('results').textContent = 'FAILED: start() did not run — ' + JSON.stringify(startRes);
    return;
  }

  // Let the initial [0,400,1200] scans settle (real timers, content.js behavior)
  await sleep(1400);

  const out = { boot_ms: window.__bootMs, ua: navigator.userAgent, started: startRes.owner || null, scenarios: {} };

  // --- Scenario A: scroll churn (append a row per tick, list closed) --------
  {
    const samples = [];
    const aRows = [];
    for (let i = 0; i < 120; i++) {
      // append happens INSIDE the measured tick so observer callback + scan are timed
      samples.push(await tick(() => { aRows.push(addRow({ followsYou: false })); }));
    }
    out.scenarios.A = { label: 'scroll churn: append row + scan (list closed)', ...round(stats(samples)), final: +samples[samples.length - 1].toFixed(2) };
  }

  // --- Scenario B: list open, state unchanged (pure DOM churn) ---------------
  {
    await sendMsg({ type: 'xfl.toggleList' });
    const probe = document.createElement('div'); probe.setAttribute('data-testid', 'probe');
    stage.append(probe);
    await sleep(50);
    probe.remove(); await null; await null; // settle
    const samples = [];
    for (let i = 0; i < 60; i++) samples.push(await tick(() => { stage.append(probe); }));
    out.scenarios.B = { label: 'list OPEN, state unchanged: DOM churn + scan + paint/renderList', ...round(stats(samples)) };
    await sendMsg({ type: 'xfl.toggleList' }); // close
  }

  // --- Scenario B2: list open, name churn → renderList data really changes ---
  {
    await sendMsg({ type: 'xfl.toggleList' });
    const samples = [];
    for (let i = 0; i < 60; i++) {
      const r = rows[i % rows.length];
      samples.push(await tick(() => {
        r.nm.firstChild && r.nm.removeChild(r.nm.firstChild);
        r.nm.append(document.createTextNode('Bench ' + r.h + ' v' + i));
      }));
    }
    out.scenarios.B2 = { label: 'list OPEN, visible name churn → renderList rebuild', ...round(stats(samples)) };
    await sendMsg({ type: 'xfl.toggleList' });
  }

  // --- Scenario C: pointer movement over a cell (3×30-event bursts) ----------
  {
    // Need a cell where the handler finds unfollow+avatar → use a seeded row
    const target = rows[1].cell;
    const btn = target.querySelector('button[data-testid$="-unfollow"]');
    const fr = btn.getBoundingClientRect();
    const evs = [];
    for (let i = 0; i < 30; i++) {
      evs.push(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, isTrusted: false,
        clientX: fr.left + i, clientY: fr.top + i
      }));
    }
    const bur = [];
    const disp = [];
    for (let b = 0; b < 3; b++) {
      const t0 = performance.now();
      for (const e of evs) target.dispatchEvent(e);
      // dispatch süresi: pre-fix = 30 handler koşumu, post-fix = 30 rAF planı
      // (frame beklentisi ölçümün DIŞINDA — throttle etkisini izole eder)
      disp.push(performance.now() - t0);
      // two frame turns: throttled handler runs in the first, then settle
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      bur.push(performance.now() - t0);
    }
    out.scenarios.C = {
      label: 'hover: 30 mousemove events over a row (per burst)',
      burst_mean: +bur.reduce((s, v) => s + v, 0) / bur.length,
      dispatch_mean: +disp.reduce((s, v) => s + v, 0) / disp.length,
      bursts: bur.map((v) => +v.toFixed(2))
    };
  }

  // --- Scenario C2: throttle proof — 300 mousemove in ONE burst --------------
  {
    const target = rows[1].cell;
    const btn = target.querySelector('button[data-testid$="-unfollow"]');
    const fr = btn.getBoundingClientRect();
    const evs = [];
    for (let i = 0; i < 300; i++) {
      evs.push(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, isTrusted: false,
        clientX: fr.left + (i % 50), clientY: fr.top + i
      }));
    }
    const t0 = performance.now();
    for (const e of evs) target.dispatchEvent(e);
    // dispatch-döngüsü süresi: sadece handler çalışmayı ölçer (rAF beklemesi hariç)
    const dispatchMs = +(performance.now() - t0).toFixed(2);
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    out.scenarios.C2 = { label: 'hover throttle proof: 300 mousemove in one burst', dispatch_ms: dispatchMs };
  }

  // --- Scenario D: popup↔content message round-trips -------------------------
  {
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) await sendMsg({ type: 'xfl.getStatus' });
    out.scenarios.D = { label: 'getStatus ×200 (popup 700ms ticker)', total_ms: +(performance.now() - t0).toFixed(2) };
  }

  // --- Behavioral parity checks (E2E asserts in the bench artifact) ----------
  const st = await sendMsg({ type: 'xfl.getStatus' });
  const expectedNf = 15 + 120;
  const listRows = document.querySelectorAll(nfRowsSel).length;
  const marked = document.querySelectorAll('[data-testid="UserCell"][data-xfl="nf"]').length;
  out.checks = {
    owner_path: st.path,
    nfCount: st.nfCount,
    nfCount_expected: expectedNf,
    nfCount_pass: st.nfCount === expectedNf,
    list_rows: listRows,
    list_rows_expected: expectedNf,
    list_pass: listRows === expectedNf,
    marked_nf: marked,
    marked_pass: marked === expectedNf
  };
  out.checks.all_pass = Object.entries(out.checks).every(([k, v]) => !k.endsWith('_pass') || v);

  // --- render ----------------------------------------------------------------
  const json = JSON.stringify(out, (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v), 2);
  const holder = document.getElementById('results');
  holder.innerHTML = '';
  const tbl = document.createElement('table');
  const tr = (cells, head) => {
    const t = document.createElement('tr');
    for (const c of cells) {
      const el = document.createElement(head ? 'th' : 'td');
      el.textContent = c;
      t.append(el);
    }
    return t;
  };
  tbl.append(tr(['scenario', 'ticks', 'mean ms', 'p50 ms', 'p95 ms', 'max ms'], true));
  for (const [k, s] of Object.entries(out.scenarios)) {
    if (s.ticks) tbl.append(tr([k + ' — ' + s.label, String(s.ticks), String(s.mean), String(s.p50), String(s.p95), String(s.max)]));
    else if (k === 'C') tbl.append(tr([k + ' — ' + s.label, String(s.bursts.length), String(+s.burst_mean.toFixed(2)), '', '', '']));
    else if (k === 'C2') tbl.append(tr([k + ' — ' + s.label, '300', '', '', '', String(s.total_ms)]));
    else if (k === 'D') tbl.append(tr([k + ' — ' + s.label, '200', '', '', '', String(s.total_ms)]));
  }
  holder.append(tbl);
  const checksEl = document.createElement('p');
  checksEl.innerHTML = 'checks: ' + (out.checks.all_pass ? '<span class="pass">ALL PASS</span>' : '<span class="fail">FAIL</span>') + ' — nf=' + out.checks.nfCount + '/' + out.checks.nfCount_expected + ' · list=' + out.checks.list_rows + '/' + out.checks.list_rows_expected + ' · marked=' + out.checks.marked_nf + '/' + out.checks.nfCount_expected + ' · boot=' + out.boot_ms + 'ms';
  holder.append(checksEl);

  const script = document.createElement('script');
  script.id = 'bench-json';
  script.type = 'application/json';
  script.textContent = json;
  document.body.append(script);

  // POST the artifact to the save server (dump-dom fires too early to rely on)
  await post(outName, json);

  document.title = 'BENCH_DONE';
} catch (err) {
  // diagnostic artifact: stack + partial state so the runner is never silent
  try {
    await post(outName + '.error', JSON.stringify({
      message: String(err && err.message || err),
      stack: String(err && err.stack || ''),
      results_html: document.getElementById('results').textContent.slice(0, 400)
    }, null, 2));
  } catch (e2) { /* ignore */ }
}
})();
