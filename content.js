// X Takip Denetimi — içerik betiği
// Yaşam döngüsü:
//   1) Sayfa açılışında SADECE pasif bir mesaj dinleyicisi kurulur (RAM/CPU ≈ 0).
//   2) Kullanıcı popup'ta "▶ Başlat" dediğinde: stil + widget + MutationObserver
//      kurulur ve tarama başlar.
//   3) "⏹ Durdur" ya da /following sayfasından ayrılınca her şey sökülür,
//      işaretler temizlenir, RAM serbest bırakılır.
//
// İşaret stil rota NOTU:
//   İşaretler class yerine INLINE STYLE ile yapılır. Neden: X bir satır üstüne
//   hover olduğunda React UserCell'in className'ini yeniden yazar ve bizim
//   class'ı siler; inline style'da ise React yalnızca kendi bildiği property'leri
//   güncelleyip bizimkilerini (outline/boxShadow/opacity) bırakır.
(() => {
  'use strict';

  // Çift enjeksiyon koruması (extension güncellemesi / yeniden yükleme)
  if (document.documentElement.dataset.xflBooted === '1') return;
  document.documentElement.dataset.xflBooted = '1';

  // ------------------------------------------------------------------
  // Sabitler ve durum
  // ------------------------------------------------------------------
  const PATH_RE = /^\/([A-Za-z0-9_]{1,15})\/following\/?$/;
  const MODES = new Set(['nf', 'dim', 'only', 'off']);
  const MODE_TEXT = {
    nf:   'Kırmızı işaret',
    dim:  'Takip edenleri sönükleştir',
    only: 'Yalnızca etmeyenler kalsın',
    off:  'Kapalı'
  };
  const MAX_LIST_ROWS = 500;   // panelde gösterilir, CSV'de hepsi var
  const UNF_PAUSE = () => 2200 + Math.floor(Math.random() * 1800); // adım arası bekleme

  const S = {
    running: false,
    mode: 'nf',
    owner: null,                 // çözümlenebilirse takip listesi sahibi
    seen: new Map(),             // handle -> {name, followsYou}
    ignored: new Set(),          // IndexedDB'den gelen yoksayma listesi
    marked: new Set(),           // inline style uygulanmış hücreler (diff temizliği için)
    markedDivs: new Set(),       // gizleme uygulanan cellInnerDiv'ler
    screen: { total: 0, follow: 0, noFollow: 0 },
    nfCount: 0,                  // eyleme açık "takip etmeyen" (yoksayılanlar hariç)
    igCount: 0,                  // yoksayılan (görülen) sayısı
    nfRows: [],                  // belge sırasıyla nf satırları (atlamak için)
    unf: { running: false, stop: false, done: 0, fails: new Map() }, // toplu takipten çıkarma durumu
    obs: null,
    debT: null,
    styleEl: null,
    widget: null,
    listOpen: false,
    zeroScans: 0
  };

  // Kayıtlı modu yükle (yalnızca mod kalıcıdır; aktiflik oturumluktur)
  try {
    chrome.storage.local.get({ mode: 'nf' }, (s) => {
      S.mode = MODES.has(s.mode) ? s.mode : 'nf';
      if (S.widget) paint();
    });
  } catch (e) { /* yoksay */ }

  // ------------------------------------------------------------------
  // IndexedDB: yoksayma listesi (kalıcı)
  // ------------------------------------------------------------------
  let dbP = null;
  function db() {
    if (!dbP) {
      dbP = new Promise((res, rej) => {
        const rq = indexedDB.open('xfl-db', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('ignored', { keyPath: 'h' });
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
    }
    return dbP;
  }
  const tx = (mode, fn) => db().then((d) => new Promise((res, rej) => {
    const t = d.transaction('ignored', mode);
    fn(t.objectStore('ignored')).onsuccess = () => res();
    t.onerror = () => rej(t.error);
  }));
  const idbPut  = (h) => tx('readwrite', (st) => st.put({ h })).catch(() => {});
  const idbDel  = (h) => tx('readwrite', (st) => st.delete(h)).catch(() => {});
  function idbAll() {
    return db().then((d) => new Promise((res, rej) => {
      const rq = d.transaction('ignored').objectStore('ignored').getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    })).catch(() => []);
  }
  idbAll().then((rows) => { for (const r of rows) S.ignored.add(r.h); });

  // ------------------------------------------------------------------
  // CSS: yüzen widget + satır düğmeleri + nabız animasyonu
  // ------------------------------------------------------------------
  // İşaret sistemi: data-attribute + CSS.
  // • inline style'a dokunmuyoruz → X'in kendi satır stilleri EzİLMİYOR (üst üste binme bugı bitti)
  // • React hover'da className'i yeniden yazsa da data-* özniteliklerini silmez → işaret kalıcı
  const PAGE_CSS =
    '@keyframes xflPulse{0%,100%{box-shadow:0 0 0 0 rgba(29,155,240,0)}35%{box-shadow:0 0 0 10px rgba(29,155,240,.35)}}' +
    '[data-testid="UserCell"][data-xfl="nf"]{outline:2px solid #f4212e!important;outline-offset:-2px;border-radius:16px;box-shadow:0 0 0 4px rgba(244,33,46,.16)}' +
    '[data-testid="UserCell"][data-xfl="dim"]{opacity:.25!important;filter:grayscale(60%)!important}' +
    '[data-testid="UserCell"][data-xfl="ign"]{opacity:.55!important;filter:grayscale(45%)!important}' +
    '[data-testid="UserCell"][data-xfl-flash="1"]{outline:2px solid #1d9bf0!important;animation:xflPulse 1.8s ease!important}' +
    '@media (prefers-reduced-motion: reduce){[data-testid="UserCell"][data-xfl-flash="1"]{animation:none!important}}' +
    'div[data-testid="cellInnerDiv"][data-xfl-hide="1"]{display:none!important}';

  const UI_CSS =
    '#xfl-widget{position:fixed;bottom:16px;right:16px;z-index:2147483647;width:330px;' +
    'background:rgba(21,32,43,.97);color:#e7e9ea;border:1px solid #38444d;border-radius:16px;' +
    "font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;" +
    'padding:10px 12px 12px;box-shadow:0 12px 34px rgba(0,0,0,.55);user-select:none}' +
    '#xfl-widget *{box-sizing:border-box;margin:0}' +
    '#xfl-head{display:flex;align-items:center;gap:8px;margin-bottom:2px}' +
    '#xfl-head b{font-size:13.5px;font-weight:700;letter-spacing:-0.2px;white-space:nowrap}' +
    '#xfl-dot{width:8px;height:8px;border-radius:50%;flex:none;background:#5b7083;transition:background-color 200ms ease}' +
    '#xfl-dot.live{background:#00ba7c}' +
    '#xfl-dot.busy{background:#f4212e}' +
    '#xfl-owner{color:#8b98a5;font-size:12px;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '#xfl-close{background:none;border:none;color:#8b98a5;font-size:16px;cursor:pointer;line-height:1;padding:0 2px}' +
    '#xfl-close:hover{color:#e7e9ea}' +
    '#xfl-stats{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px}' +
    '#xfl-stats .chip{background:rgba(56,68,77,.45);border-radius:999px;padding:3px 10px;font-size:11.5px;color:#8b98a5;line-height:1.6}' +
    '#xfl-stats .chip b{color:#e7e9ea;font-weight:700}' +
    '#xfl-stats .chip.g b{color:#00ba7c}' +
    '#xfl-stats .chip.nf b{color:#f4212e}' +
    '#xfl-hint{color:#8b98a5;font-size:11.5px;margin-top:6px;display:none}' +
    '#xfl-acts1{display:flex;gap:6px;margin-bottom:6px}' +
    '#xfl-acts1 button{flex:1;border:none;border-radius:999px;padding:9px 4px;cursor:pointer;white-space:nowrap;' +
    "font:700 12.5px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;" +
    'transition:transform 160ms cubic-bezier(0.23,1,0.32,1), background-color 150ms ease, color 150ms ease}' +
    '#xfl-acts1 button:not(:disabled):active{transform:scale(0.96)}' +
    '@media (prefers-reduced-motion: reduce){#xfl-acts1 button:not(:disabled):active{transform:none}}' +
    '#xfl-b-next{background:#1d9bf0;color:#fff}' +
    '#xfl-b-unf{background:#f4212e;color:#fff}' +
    '#xfl-acts2{display:flex;gap:6px;margin-bottom:8px}' +
    '#xfl-acts2 button{flex:1;background:transparent;border:1px solid #38444d;color:#8b98a5;border-radius:999px;padding:6px 2px;cursor:pointer;white-space:nowrap;' +
    "font:600 11.5px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;" +
    'transition:transform 160ms cubic-bezier(0.23,1,0.32,1), background-color 150ms ease, color 150ms ease, border-color 150ms ease}' +
    '#xfl-acts2 button:not(:disabled):active{transform:scale(0.96)}' +
    '@media (prefers-reduced-motion: reduce){#xfl-acts2 button:not(:disabled):active{transform:none}}' +
    "#xfl-acts2 button:hover{color:#e7e9ea;border-color:#8b98a5}" +
    "#xfl-b-stop:hover{color:#f4212e;border-color:#f4212e}" +
    '#xfl-ig-link{display:none;color:#8b98a5;font-size:11.5px;margin-top:8px;cursor:pointer;text-align:right}' +
    '#xfl-ig-link:hover{color:#e7e9ea;text-decoration:underline}' +
    '#xfl-list{max-height:56vh;overflow:auto;overscroll-behavior:contain;border:1px solid #38444d;border-radius:4px;background:rgba(0,0,0,.25);position:relative}' +
    '#xfl-list[hidden]{display:none}' +
    '#xfl-list::-webkit-scrollbar{width:8px}' +
    '#xfl-list::-webkit-scrollbar-thumb{background:#38444d;border-radius:8px}' +
    '#xfl-list::-webkit-scrollbar-track{background:transparent}' +
    '#xfl-list-h{position:sticky;top:0;background:#15202b;padding:7px 10px;font-size:12px;border-bottom:1px solid #38444d;color:#8b98a5}' +
    '#xfl-row{display:flex;gap:8px;padding:6px 10px;border-bottom:1px solid rgba(56,68,77,.4);align-items:baseline;cursor:pointer;transition:background-color 150ms ease}' +
    '#xfl-row:hover{background:rgba(29,155,240,.07)}' +
    '#xfl-row a{color:#1d9bf0;text-decoration:none;font-weight:600;white-space:nowrap}' +
    '#xfl-row a:hover{text-decoration:underline}' +
    '#xfl-row .nm{color:#8b98a5;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '#xfl-row .unig{margin-left:auto;background:none;border:none;color:#5b7083;cursor:pointer;font-size:12px}' +
    '#xfl-row .unig:hover{color:#e7e9ea}' +
    '.xfl-igrow{opacity:.6}' +
    '.xfl-ighead{padding:7px 10px;font-size:11.5px;color:#8b98a5;border-top:2px solid #38444d;margin-top:4px}' +
    '#xfl-more{padding:8px 10px;color:#8b98a5;font-size:11.5px}' +
    '.xfl-ign{position:fixed;z-index:2147483647;' +
    'border:1px solid #38444d;background:#1c2732;color:#8b98a5;border-radius:999px;' +
    "font:600 11px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;" +
    'padding:4px 10px;cursor:pointer;line-height:1.4;' +
    'box-shadow:0 4px 12px rgba(0,0,0,.4);white-space:nowrap;' +
    'transition:background-color 150ms ease, color 150ms ease, border-color 150ms ease}' +
    '@media (prefers-reduced-motion: no-preference){' +
    '.xfl-ign{transition:background-color 150ms ease, color 150ms ease, border-color 150ms ease, transform 160ms cubic-bezier(0.23,1,0.32,1)}' +
    '.xfl-ign:active{transform:scale(0.96)}}' +
    '.xfl-ign:hover{border-color:#8b98a5;color:#e7e9ea}' +
    '.xfl-ign.on{border-color:#5b7083;background:#5b7083;color:#fff}';

  function injectStyles() {
    if (S.styleEl) return;
    S.styleEl = document.createElement('style');
    S.styleEl.textContent = PAGE_CSS + UI_CSS;
    document.documentElement.appendChild(S.styleEl);
  }

  // ------------------------------------------------------------------
  // Yardımcılar
  // ------------------------------------------------------------------
  const pathMatch = () => location.pathname.match(PATH_RE);

  // Satırın sayfadaki (düşey) konumu — Sonrakine Geç sıralaması için
  const yOf = (el) => el.getBoundingClientRect().top + (window.scrollY || 0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Sahibin handle'ını DOM'dan çöz: div[data-testid="UserName"] içinde "@handle"
  function ownerFromDom() {
    const el = document.querySelector('div[data-testid="UserName"]');
    if (!el) return null;
    const m = el.textContent.match(/@([A-Za-z0-9_]{1,15})\b/);
    return m ? m[1] : null;
  }

  // İşaret kind'ı: 'nf' | 'dim' | 'ign' ('plain' = işaretsiz)
  function setCellKind(el, kind) {
    if (kind === 'plain') delete el.dataset.xfl;
    else el.dataset.xfl = kind;
  }

  function setHide(el, hide) {
    if (hide) el.dataset.xflHide = '1';
    else delete el.dataset.xflHide;
  }

  function clearMarks() {
    document.querySelectorAll('[data-testid="UserCell"][data-xfl]')
      .forEach((el) => delete el.dataset.xfl);
    document.querySelectorAll('[data-testid="UserCell"][data-xfl-flash]')
      .forEach((el) => delete el.dataset.xflFlash);
    document.querySelectorAll('div[data-testid="cellInnerDiv"][data-xfl-hide]')
      .forEach((el) => delete el.dataset.xflHide);
    S.marked = new Set();
    S.markedDivs = new Set();
  }

  function sendStats() {
    try {
      chrome.runtime.sendMessage({ type: 'xfl.stats', count: S.running ? S.nfCount : 0 })
        .catch(() => {});
    } catch (e) { /* bağlam geçersiz olabilir */ }
  }

  function status() {
    return {
      running: S.running,
      pathOk: !!pathMatch(),
      owner: S.owner,
      mode: S.mode,
      modeText: MODE_TEXT[S.mode],
      screen: S.screen,
      nfCount: S.nfCount,
      igCount: S.ignored.size,
      unfRunning: S.unf.running,
      unfDone: S.unf.done,
      listOpen: S.listOpen,
      path: pathMatch() ? pathMatch()[1] : null
    };
  }

  // Yoksayma listesi (IndexedDB'deki TÜM kayıtlar), ada göre sıralı
  function igListSorted() {
    return [...S.ignored]
      .sort((a, b) => a.localeCompare(b))
      .map((h) => ({ h, name: (S.seen.get(h) || {}).name || '' }));
  }

  const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

  // h yoksayıldı → true; h yoksayılmaktan çıkarıldı → false
  function setIgnored(hRaw, val) {
    const h = String(hRaw || '').replace(/^@/, '').trim().toLowerCase();
    if (!HANDLE_RE.test(h)) return null;
    if (val) {
      S.ignored.add(h);
      idbPut(h);
    } else {
      S.ignored.delete(h);
      idbDel(h);
    }
    if (S.running) scan(); else if (S.widget) renderList();
    return h;
  }

  // ------------------------------------------------------------------
  // Yoksay — satırın ÜSTÜNE YÜZEN overlay düğme (React ağacına hiç girmez;
  // satır DOM'una enjeksiyon yapmıyoruz ki React patch çakışması olmasın)
  // ------------------------------------------------------------------
  const HOVER = { h: null };

  function buildHoverButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'xfl-hover';
    btn.className = 'xfl-ign';
    btn.style.display = 'none';          // hover gelince .show görünecek
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      if (!HOVER.h) return;
      const h = HOVER.h;
      const nowOn = !S.ignored.has(h);
      setIgnored(h, nowOn);              // indexedDB + scan
      btn.classList.toggle('on', nowOn);
      btn.textContent = nowOn ? '🚫 Yoksayıldı' : 'Ø Yoksay';
    });
    document.documentElement.appendChild(btn);
    return btn;
  }

  function hideHover() {
    HOVER.h = null;
    if (S.hoverBtn) {
      S.hoverBtn.style.display = 'none';
      S.hoverBtn.classList.remove('show');
    }
  }

  function onHoverMove(e) {
    if (!S.running || !S.hoverBtn) return;
    const t = e.target;
    if (!t || !t.closest) { hideHover(); return; }
    if (t.closest && t.closest('#xfl-hover')) return;    // ilgili düğmedeyiz, kal
    const cell = t.closest && t.closest('[data-testid="UserCell"]');
    if (!cell) { hideHover(); return; }
    const unfollowBtn = cell.querySelector('button[data-testid$="-unfollow"]');
    const av = cell.querySelector('div[data-testid^="UserAvatar-Container-"]');
    if (!unfollowBtn || !av) { hideHover(); return; }
    const h = (av.getAttribute('data-testid') || '').replace('UserAvatar-Container-', '').toLowerCase();
    if (!h) { hideHover(); return; }

    HOVER.h = h;
    const on = S.ignored.has(h);
    S.hoverBtn.classList.toggle('on', on);
    S.hoverBtn.textContent = on ? '🚫 Yoksayıldı' : 'Ø Yoksay';
    if (!S.hoverBtn.classList.contains('show')) S.hoverBtn.classList.add('show');
    S.hoverBtn.style.display = 'block';

    // Following düğmesinin solunda, dikeyde ortalı, çakışmadan
    const fr = unfollowBtn.getBoundingClientRect();
    const bw = S.hoverBtn.offsetWidth || 78;
    const bh = S.hoverBtn.offsetHeight || 26;
    let left = fr.left - bw - 6;
    if (left < 8) left = fr.right + 6;
    S.hoverBtn.style.left = left + 'px';
    S.hoverBtn.style.top = (fr.top + fr.height / 2 - bh / 2) + 'px';
  }


  // ------------------------------------------------------------------
  // Tarama
  // ------------------------------------------------------------------
  function scan() {
    if (!S.running) return;

    // Kullanıcı SPA ile /following sayfasından ayrıldıysa kendini kapat
    const def = pathMatch();
    if (!def) { stop(true); return; }

    const st = { total: 0, follow: 0, noFollow: 0 };
    S.nfRows = [];
    const touched = new Set();

    const cells = document.querySelectorAll('[data-testid="UserCell"]');
    for (const cell of cells) {
      // "unfollow" düğmesi = biz onu takip ediyoruz (takip edilenler listesindeyiz)
      const unfollow = cell.querySelector('button[data-testid$="-unfollow"]');
      if (!unfollow) continue; // "Follow" düğmeli satırlar (öneriler vb.) atlanır

      const avatar = cell.querySelector('div[data-testid^="UserAvatar-Container-"]');
      if (!avatar) continue;
      const attrs = avatar.getAttribute('data-testid') || '';
      const handle = attrs.replace('UserAvatar-Container-', '');
      if (!handle) continue;
      const hLower = handle.toLowerCase();

      const nameEl = cell.querySelector('span');
      const name = nameEl ? nameEl.textContent : '';

      const followsYou = !!cell.querySelector('div[data-testid="userFollowIndicator"]');
      st.total++;
      if (followsYou) st.follow++; else st.noFollow++;

      // İşaret kind'ı belirle
      let kind = 'plain';
      const isIgn = S.ignored.has(hLower);
      if (!followsYou) {
        kind = isIgn ? 'ign' : (S.mode === 'off' ? 'plain' : 'nf');
      } else if (S.mode === 'dim') {
        kind = 'dim';
      }
      if (kind !== 'plain') { setCellKind(cell, kind); touched.add(cell); }
      else if (cell.dataset.xfl) { delete cell.dataset.xfl; touched.add(cell); }

      if (!followsYou && !isIgn) {
        S.nfRows.push({ el: cell, h: hLower, y: yOf(cell) });
      }

      S.seen.set(hLower, { name, followsYou, ignored: isIgn });
    }

    // Bu turda dokunulmayan ama daha önce işaretli hücreleri temizle
    for (const el of S.marked) {
      if (!touched.has(el) && el.isConnected && el.dataset.xfl) delete el.dataset.xfl;
    }
    S.marked = touched;

    // Sayfadaki gerçek (yukarıdan aşağıya) sıra
    S.nfRows.sort((a, b) => a.y - b.y);

    // "only" modunda görünen konteynerleri gizle (takip edenler + yoksayılanlar).
    // Not: mod dışındaysa daha önce gizlenenleri MUTLAKA geri koy — aksi halde
    // display:none kalır ve satırlar kaybolur (bug).
    if (S.mode === 'only') {
      const visited = new Set();
      document.querySelectorAll('div[data-testid="cellInnerDiv"]').forEach((div) => {
        const cell = div.querySelector('[data-testid="UserCell"]');
        const av = cell && cell.querySelector('div[data-testid^="UserAvatar-Container-"]');
        const h = av ? (av.getAttribute('data-testid') || '').replace('UserAvatar-Container-', '').toLowerCase() : null;
        const info = h ? S.seen.get(h) : null;
        const keep = !!(info && info.followsYou === false && !S.ignored.has(h));
        const hide = !!(cell && !keep);
        setHide(div, hide);
        if (hide) visited.add(div);
      });
      for (const el of S.markedDivs) {
        if (!visited.has(el) && el.isConnected && el.dataset.xflHide) delete el.dataset.xflHide;
      }
      S.markedDivs = visited;
    } else {
      for (const el of S.markedDivs) {
        if (el.isConnected && el.dataset.xflHide) delete el.dataset.xflHide;
      }
      S.markedDivs = new Set();
    }

    // Sahip doğrulaması (ilk fırsatta)
    if (!S.owner) {
      const o = ownerFromDom();
      if (o) {
        if (o.toLowerCase() !== def[1].toLowerCase()) { stop(true); return; }
        S.owner = o;
      }
    }

    S.screen = st;
    S.zeroScans = st.total === 0 ? S.zeroScans + 1 : 0;

    // Sayaçlar
    let nf = 0, ig = 0;
    for (const [h, v] of S.seen) {
      if (!v.followsYou) {
        if (S.ignored.has(h)) ig++; else nf++;
      }
    }
    S.nfCount = nf;      // eyleme açık
    S.igCount = ig;

    if (S.listOpen) renderList();
    if (S.widget) paint();
    sendStats();
  }

  function onMut() {
    if (!S.running) return;
    clearTimeout(S.debT);
    S.debT = setTimeout(scan, 150);
  }

  // ------------------------------------------------------------------
  // Satıra atlama ("Sonraki" ve listeden tıklama)
  // ------------------------------------------------------------------
  function flashRow(el) {
    el.dataset.xflFlash = '1';   // CSS: mavi çerçeve + nabız (reduced-motion'da statik)
    setTimeout(() => { delete el.dataset.xflFlash; }, 1900);
  }

  function hintOnce(text, ms) {
    const r = widgetRefs();
    if (!r || !r.hint) return;
    r.hint.style.display = 'block';
    r.hint.textContent = text;
    setTimeout(() => { if (r.hint.textContent === text) r.hint.style.display = 'none'; }, ms || 2000);
  }

  function jumpToCell(row) {
    if (!row || !row.el || !row.el.isConnected) return false;
    row.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flashRow(row.el);
    return true;
  }

  // "⏭ Sonraki": görünümün altındaki ilk takip-etmeyen satıra kaysın; sonuna geldiğinde başa sarar
  function jumpNext() {
    if (!S.running) return;
    const rows = S.nfRows.filter((r) => r.el && r.el.isConnected);
    if (!rows.length) {
      hintOnce('Ekranda işaretli satır yok — listeyi yüklemek için kaydır.', 2400);
      return;
    }
    const anchor = (window.scrollY || 0) + window.innerHeight * 0.45;
    const target = rows.find((r) => yOf(r.el) > anchor) || rows[0]; // sonuna geldiyse başa dön
    jumpToCell(target);
  }

  // ------------------------------------------------------------------
  // Widget
  // ------------------------------------------------------------------
  function buildWidget() {
    const w = document.createElement('div');
    w.id = 'xfl-widget';

    // Başlık: durum noktası + ad + kapat
    const head = document.createElement('div');
    head.id = 'xfl-head';
    const dot = document.createElement('span'); dot.id = 'xfl-dot';
    const b = document.createElement('b'); b.textContent = 'Takip Denetimi';
    const x = document.createElement('button'); x.id = 'xfl-close'; x.title = 'Durdur ve kapat'; x.textContent = '✕';
    head.append(dot, b, x);

    // Alt bilgi satırı: @sahip · mod
    const owner = document.createElement('div');
    owner.id = 'xfl-owner';

    // İstatistik chip'leri
    const stats = document.createElement('div');
    stats.id = 'xfl-stats';
    const hint = document.createElement('div');
    hint.id = 'xfl-hint';

    // Birincil eylemler
    const acts1 = document.createElement('div');
    acts1.id = 'xfl-acts1'; acts1.className = 'xfl-acts';
    const bNext = document.createElement('button'); bNext.id = 'xfl-b-next'; bNext.title = 'Sıradaki takip etmeyen satıra atla'; bNext.textContent = '⏭ Sonraki';
    const bUnf  = document.createElement('button'); bUnf.id = 'xfl-b-unf';  bUnf.title = 'Yoksayılmayan takip etmeyenleri takipten çıkar';
    acts1.append(bNext, bUnf);

    // İkincil eylemler (sade)
    const acts2 = document.createElement('div');
    acts2.id = 'xfl-acts2'; acts2.className = 'xfl-acts';
    const bList = document.createElement('button'); bList.id = 'xfl-b-list';
    const bCsv  = document.createElement('button'); bCsv.id = 'xfl-b-csv'; bCsv.textContent = '⬇ CSV';
    const bStop = document.createElement('button'); bStop.id = 'xfl-b-stop'; bStop.textContent = '⏹ Kapat';
    acts2.append(bList, bCsv, bStop);

    // Liste
    const list = document.createElement('div');
    list.id = 'xfl-list';
    list.hidden = true;
    const lh = document.createElement('div'); lh.id = 'xfl-list-h';
    const lb = document.createElement('div'); lb.id = 'xfl-list-body';
    list.append(lh, lb);

    w.append(head, owner, stats, hint, acts1, acts2, list);

    // Yoksayma listesi kısayolu (listeyi açar, 🚫 bölümüne kaydırır)
    const igLink = document.createElement('span');
    igLink.id = 'xfl-ig-link';
    igLink.title = 'Tüm yoksayılanları gör / / listeden çıkar';
    igLink.addEventListener('click', () => {
      if (!S.listOpen) { S.listOpen = true; list.hidden = false; paint(); }
      renderList(true);
    });

    document.documentElement.appendChild(w);
    w.appendChild(igLink);

    S.hoverBtn = buildHoverButton();
    document.addEventListener('mousemove', onHoverMove, true);
    document.addEventListener('scroll', hideHover, true);

    x.addEventListener('click', () => stop(true));
    bStop.addEventListener('click', () => stop(true));
    bNext.addEventListener('click', jumpNext);
    bUnf.addEventListener('click', () => {
      if (S.unf.running) { S.unf.stop = true; return; }
      const n = S.nfCount;
      if (!n) { hintOnce('Eyleme açık "takip etmeyen" yok. Önce listeyi kaydırarak tarayın.', 2600); return; }
      if (!confirm(`${n} hesabı takipten çıkarılacak.\n\n• Yoksaydıkların (🚫) atlanır.\n• Her chağrı adımında onay penceresi açılır.\n\nDevam edilsin mi?`)) return;
      runUnfollow();
    });
    bList.addEventListener('click', () => { S.listOpen = !S.listOpen; list.hidden = !S.listOpen; paint(); if (S.listOpen) renderList(); });
    bCsv.addEventListener('click', saveCsv);

    // Liste panelinde: ✕ ile yoksaymadan çıkar; satır (bağlantı değil) tıklanınca o satıra atla
    lb.addEventListener('click', (e) => {
      const un = e.target.closest('.xfl-unig');
      if (un) {
        const h = un.dataset.h;
        if (h) { S.ignored.delete(h); idbDel(h); renderList(); scan(); }
        return;
      }
      if (e.target.closest('a')) return;
      const rowEl = e.target.closest('#xfl-row');
      if (!rowEl || !rowEl.dataset.h) return;
      const row = (S.nfRows || []).find((x) => x.h === rowEl.dataset.h);
      if (!jumpToCell(row)) {
        hintOnce('@' + rowEl.dataset.h + ' şu anda render edilmemiş — yavaşça kaydırıp tekrar tıkla.', 2600);
      }
    });

    S.widget = w;
    S.listEl = list;
    S.bUnfEl = bUnf;
    S.igLinkEl = igLink;
    paint();
  }

  function widgetRefs() {
    if (!S.widget) return null;
    return {
      dot: S.widget.querySelector('#xfl-dot'),
      owner: S.widget.querySelector('#xfl-owner'),
      stats: S.widget.querySelector('#xfl-stats'),
      hint: S.widget.querySelector('#xfl-hint'),
      list: S.widget.querySelector('#xfl-list'),
      lh: S.widget.querySelector('#xfl-list-h'),
      lb: S.widget.querySelector('#xfl-list-body'),
      igLink: S.widget.querySelector('#xfl-ig-link'),
      bList: S.widget.querySelector('#xfl-b-list'),
      bUnf: S.widget.querySelector('#xfl-b-unf')
    };
  }

  function paint() {
    const r = widgetRefs();
    if (!r) return;
    const def = pathMatch();

    // Durum noktası + alt bilgi: @sahip · mod
    r.dot.classList.toggle('busy', S.unf.running);
    r.dot.classList.toggle('live', !S.unf.running);
    r.owner.textContent = '@' + (S.owner || (def ? def[1] : '?')) + ' · ' + (MODE_TEXT[S.mode] || S.mode);

    // İstatistik chip'leri
    const { total, follow, noFollow } = S.screen;
    r.stats.innerHTML = '';
    const chip = (cls, label, val) => {
      const c = document.createElement('span');
      c.className = 'chip' + (cls ? ' ' + cls : '');
      c.append(label + ' ');
      if (val !== null && val !== undefined) {
        const bb = document.createElement('b');
        bb.textContent = String(val);
        c.appendChild(bb);
      }
      return c;
    };
    r.stats.append(
      chip('', 'Ekranda', total),
      chip('g', 'Geri takip', follow),
      chip('nf', 'Etmeyen', noFollow)
    );
    if (S.ignored.size) r.stats.append(chip('', '🚫', S.ignored.size));
    if (S.unf.running) r.stats.append(chip('nf', '…çıkarılıyor', S.unf.done));

    r.hint.style.display = S.zeroScans >= 3 && !S.unf.running ? 'block' : 'none';
    if (S.zeroScans >= 3) r.hint.textContent = 'Yükleniyor olabilir; kaydır ya da birkaç sn bekle.';

    r.bList.textContent = S.listOpen ? '☰ Listeyi Gizle' : '☰ Liste (' + S.nfCount + ')';
    r.bUnf.classList.toggle('busy', S.unf.running);
    r.bUnf.textContent = S.unf.running ? '⏹ İptal (' + S.unf.done + ')' : '🧹 Çıkar (' + S.nfCount + ')';
    if (r.igLink) {
      const n = S.ignored.size;
      r.igLink.style.display = n ? 'block' : 'none';
      r.igLink.textContent = '🚫 Yoksayma listesi (' + n + ') — düzenle →';
    }
  }

  function renderList(scrollToIg) {
    const r = widgetRefs();
    if (!r || !S.listOpen) return;

    // Eyleme açık "takip etmeyenler" (yoksayılanlar hariç)
    const rows = [];
    for (const [h, v] of S.seen) {
      if (!v.followsYou && !S.ignored.has(h)) rows.push([h, v]);
    }
    rows.sort((a, b) => a[0].localeCompare(b[0]));

    // Yoksayılanlar: IndexedDB'deki TÜM kayıtlar (bu sayfada görülmemişler dahil)
    const igs = igListSorted();

    r.lh.textContent = 'Takip etmeyenler (' + rows.length + ')' + (igs.length ? ' · 🚫 yoksayılan ' + igs.length : '');
    r.lb.innerHTML = '';
    const frag = document.createDocumentFragment();
    const lim = Math.min(rows.length, MAX_LIST_ROWS);
    for (let i = 0; i < lim; i++) {
      const [h, v] = rows[i];
      const row = document.createElement('div'); row.id = 'xfl-row';
      row.dataset.h = h;
      row.title = 'Satıra atlamak için tıkla';
      const a = document.createElement('a');
      a.href = '/' + h; a.textContent = '@' + h; a.target = '_self';
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = v.name || '';
      row.append(a, nm);
      frag.appendChild(row);
    }
    if (rows.length > MAX_LIST_ROWS) {
      const more = document.createElement('div'); more.id = 'xfl-more';
      more.textContent = '… +' + (rows.length - MAX_LIST_ROWS) + ' hesap daha (CSV dosyasında hepsi var)';
      frag.appendChild(more);
    }
    if (!rows.length) {
      const emp = document.createElement('div'); emp.id = 'xfl-more';
      emp.textContent = 'Henüz "takip etmeyen" bulunamadı.';
      frag.appendChild(emp);
    }
    // Yoksayılanlar
    if (igs.length) {
      const headEl = document.createElement('div');
      headEl.className = 'xfl-ighead';
      headEl.textContent = '🚫 Yoksayma listesi (' + igs.length + ') — ✕ ile çıkar';
      frag.appendChild(headEl);
      const limIg = igs.length;
      for (let i = 0; i < limIg; i++) {
        const [h, v] = [igs[i].h, igs[i]];
        const row = document.createElement('div'); row.id = 'xfl-row'; row.className = 'xfl-igrow';
        const a = document.createElement('a');
        a.href = '/' + h; a.textContent = '@' + h; a.target = '_self';
        const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = v.name || '';
        const un = document.createElement('button');
        un.className = 'xfl-unig'; un.textContent = '✕'; un.title = 'Yoksayma listesinden çıkar';
        un.dataset.h = h;
        row.append(a, nm, un);
        frag.appendChild(row);
      }
    }
    r.lb.appendChild(frag);
    if (scrollToIg) {
      const headEl = r.lb.querySelector('.xfl-ighead');
      if (headEl) { r.lb.scrollTop = headEl.offsetTop - r.lb.offsetTop - 8; }
      else hintOnce('Yoksayma listesi şu an boş.', 2000);
    }
  }

  // ------------------------------------------------------------------
  // CSV indir
  // ------------------------------------------------------------------
  function saveCsv() {
    const rows = [];
    for (const [h, v] of S.seen) {
      if (!v.followsYou && !S.ignored.has(h)) rows.push([h, v.name || '']);
    }
    rows.sort((a, b) => a[0].localeCompare(b[0]));
    const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    let csv = '\ufeffhandle,Ad\n' + rows.map(r => esc(r[0]) + ',' + esc(r[1])).join('\n');
    if (!rows.length) csv += '(boş)\n';

    const date = new Date().toISOString().slice(0, 10);
    const owner = S.owner || pathMatch()?.[1] || 'x';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `takip-etmeyenler-${owner}-${date}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ------------------------------------------------------------------
  // Toplu takipten çıkarma (yoksayılanlar atlanır)
  // ------------------------------------------------------------------
  async function runUnfollow() {
    if (S.unf.running) return;
    S.unf.running = true;
    S.unf.stop = false;
    S.unf.done = 0;
    S.unf.fails = new Map();
    paint();

    const nextTarget = () => {
      const rows = S.nfRows.filter((r) => {
        if (!r.el || !r.el.isConnected) return false;
        if (S.ignored.has(r.h)) return false;
        if ((S.unf.fails.get(r.h) || 0) >= 2) return false; // arka arkaya hata veren satırı atla
        const info = S.seen.get(r.h);
        if (info && info.done) return false;                 // zaten işlendi (satır güncellenene dek)
        return true;
      });
      return rows[0] || null;
    };

    try {
      for (;;) {
        if (!S.running || S.unf.stop) break;

        const row = nextTarget();
        if (!row) {
          // Ekranda hedef kalmadı: aşağı kaydır, yeni veri gelmiyorsa son
          const before = (window.scrollY || 0);
          window.scrollBy({ top: Math.max(window.innerHeight * 2.5, 900), behavior: 'instant' });
          await sleep(1400);
          scan();
          const rowAgain = nextTarget();
          const moved = Math.abs((window.scrollY || 0) - before) > 40;
          if (!rowAgain && !moved) { hintOnce('✔ Liste sonuna ulaşıldı. ' + S.unf.done + ' hesap çıkarıldı.', 4000); break; }
          if (!rowAgain && moved) continue;
        }

        const cell = row.el;
        const btn = cell.querySelector('button[data-testid$="-unfollow"]');
        if (!btn) { await sleep(300); scan(); continue; }

        const h = row.h;
        flashRow(cell);
        btn.click();
        await sleep(700);

        // Onay penceresi (X'in confirmation sheet'i)
        const cBtn = document.querySelector('button[data-testid="confirmationSheetConfirm"]');
        if (cBtn) { cBtn.click(); await sleep(400); }

        // Buton hâlâ "unfollow" durumunda ve onay geldiyse başarılı say
        const stillUnfollow = cell.isConnected && cell.querySelector('button[data-testid$="-unfollow"]');
        if (!stillUnfollow && cBtn) {
          S.unf.done++;
          const info = S.seen.get(h);
          if (info) { info.done = true; info.followsYou = 'removed'; } // sayaç/panel/CSV dışı bırak
          S.unf.fails.delete(h);
        } else if (cBtn) {
          // onay var ama satır geçilmedi → sayaç işaretle, sonraki tur tekrar dener
        } else {
          // onay penceresi hiç açılmadı → hata say, arka arkaya 2 kez olur atla
          const f = (S.unf.fails.get(h) || 0) + 1;
          S.unf.fails.set(h, f);
          if (f >= 2) { const info = S.seen.get(h); if (info) info.done = true; }
        }
        paint();

        await sleep(UNF_PAUSE());
        scan();
      }
    } finally {
      S.unf.running = false;
      S.unf.stop = false;
      scan();
      if (S.unf.done) hintOnce('✔ ' + S.unf.done + ' hesabı takipten çıkardım.', 4000);
      paint();
    }
  }

  // ------------------------------------------------------------------
  // Başlat / Durdur
  // ------------------------------------------------------------------
  function start() {
    if (S.running) return status();

    const def = pathMatch();
    if (!def) return { ok: false, reason: 'not-following-page' };

    // Sahibe doğrulaması: DNS çözümlenebilirse URL handle'ı ile karşılaştır
    const o = ownerFromDom();
    if (o && o.toLowerCase() !== def[1].toLowerCase()) {
      return { ok: false, reason: 'owner-mismatch', owner: o, path: def[1] };
    }
    S.owner = o;

    injectStyles();
    buildWidget();

    S.obs = new MutationObserver(onMut);
    S.obs.observe(document.body, { childList: true, subtree: true });

    S.running = true;
    S.zeroScans = 0;
    S.nfRows = [];
    // İlk yakalamalar: sayfa henüz yükleniyor olabilir
    [0, 400, 1200].forEach((d) => setTimeout(scan, d));

    paint();
    sendStats();
    return status();
  }

  function stop(auto) {
    S.unf.stop = true;              // toplu çıkarma döngüsünü bitecek
    hideHover();
    document.removeEventListener('mousemove', onHoverMove, true);
    document.removeEventListener('scroll', hideHover, true);
    if (S.hoverBtn) { S.hoverBtn.remove(); S.hoverBtn = null; }
    if (!S.running && !S.unf.running) return status();
    S.running = false;

    if (S.obs) { S.obs.disconnect(); S.obs = null; }
    clearTimeout(S.debT);

    clearMarks();
    if (S.styleEl) { S.styleEl.remove(); S.styleEl = null; }
    if (S.widget) { S.widget.remove(); S.widget = null; S.listEl = null; S.bUnfEl = null; S.igLinkEl = null; }

    S.listOpen = false;
    S.zeroScans = 0;
    S.screen = { total: 0, follow: 0, noFollow: 0 };
    S.seen.clear();          // RAM'i serbest bırak
    S.nfRows = [];           // satır referanslarını da bırak
    S.nfCount = 0;
    S.igCount = 0;

    sendStats();             // rozeti temizle
    if (auto) console.log('[XFL] Sayfadan ayrıldın, tarama otomatik durduruldu.');
    return status();
  }

  // ------------------------------------------------------------------
  // Mesaj yönetimi (aktivasyon buradan gelir — pasif dinleyici)
  // ------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'xfl.getStatus':
        sendResponse(status());
        break;
      case 'xfl.start':
        sendResponse(start());
        break;
      case 'xfl.stop':
        sendResponse(stop());
        break;
      case 'xfl.setMode': {
        if (MODES.has(msg.mode)) {
          S.mode = msg.mode;
          try { chrome.storage.local.set({ mode: S.mode }); } catch (e) {}
          if (S.running) { if (S.mode === 'off') clearMarks(); scan(); }
        }
        sendResponse({ ok: true, mode: S.mode, running: S.running });
        break;
      }
      case 'xfl.toggleList': {
        if (!S.running || !S.listEl) {
          S.listOpen = false;
          sendResponse({ ok: false, reason: 'not-running' });
          break;
        }
        S.listOpen = !S.listOpen;
        S.listEl.hidden = !S.listOpen;
        paint();
        if (S.listOpen) renderList();
        sendResponse({ ok: true, listOpen: S.listOpen });
        break;
      }
      case 'xfl.saveCsv': {
        if (!S.running) { sendResponse({ ok: false, reason: 'not-running' }); break; }
        saveCsv();
        sendResponse({ ok: true, count: S.nfCount });
        break;
      }
      case 'xfl.unfollow': {
        if (!S.running) { sendResponse({ ok: false, reason: 'not-running' }); break; }
        if (S.unf.running) { sendResponse({ ok: true, already: true }); break; }
        if (!S.nfCount) { sendResponse({ ok: false, reason: 'nothing-to-do' }); break; }
        runUnfollow();
        sendResponse({ ok: true, count: S.nfCount });
        break;
      }

      // --- Yoksayma listesi yönetimi (tarama kapalıyken de çalışır) ---
      case 'xfl.ignoreList':
        sendResponse({ ok: true, list: igListSorted() });
        break;
      case 'xfl.ignoreAdd': {
        const h = setIgnored(msg.h, true);
        sendResponse(h ? { ok: true, h, list: igListSorted() } : { ok: false, reason: 'bad-handle' });
        break;
      }
      case 'xfl.ignoreRemove': {
        const h = setIgnored(msg.h, false);
        sendResponse(h ? { ok: true, h, list: igListSorted() } : { ok: false, reason: 'bad-handle' });
        break;
      }
      case 'xfl.ignoreClear': {
        const n = S.ignored.size;
        for (const h of [...S.ignored]) idbDel(h);
        S.ignored.clear();
        if (S.running) scan();
        sendResponse({ ok: true, removed: n, list: [] });
        break;
      }
      default:
        break;
    }
    // senkron yanıt veriyoruz; return değeri önemsiz
  });

  console.log('[XFL] İçerik betiği hazır (pasif). Popup\'tan ▶ Başlat ile etkinleştir.');
})();
