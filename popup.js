// X Takip Denetimi — popup kontrol betiği
const $ = (s) => document.querySelector(s);

let tab = null;
let canControl = false;   // içerik betiği cevap veriyor mu
let isFollowing = false;  // aktif sekme /handle/following sayfası mı

function fmt(st) {
  if (!st) return '';
  const s = st.screen || { total: 0, follow: 0, noFollow: 0 };
  const ig = st.igCount ? ` · 🚫 ${st.igCount}` : '';
  const unfTxt = st.unfRunning ? ` · <span class="nf">çıkarılıyor… ${st.unfDone}</span>` : '';
  return `Ekranda <b>${s.total}</b> · geri takip <b>${s.follow}</b> · etmeyen <span class="nf">${st.nfCount}</span>${ig}${unfTxt} · mod: ${st.modeText}`;
}

function setInfo(msg, warn = false) {
  const el = $('#info');
  el.textContent = msg;
  el.classList.toggle('warn', warn);
}

function render(st) {
  const tgl = $('#toggle');
  const ctl = $('#controls');
  const running = st && st.running;

  if (!canControl) {
    tgl.disabled = true;
    tgl.textContent = '▶ Başlat';
    ctl.classList.add('off');
    return;
  }
  tgl.disabled = !isFollowing;

  if (running) {
    tgl.disabled = false;
    tgl.className = 'run';
    tgl.textContent = '⏹ Durdur';
    ctl.classList.remove('off');
    $('#stats').innerHTML = fmt(st);
    if (st.owner) { /* sahibi widget zaten gösteriyor */ }
    if (isFollowing) {
      const seg = document.querySelectorAll('input[name="mode"]');
      seg.forEach((r) => { r.checked = r.value === st.mode; });
      $('#list').disabled = false;
      $('#csv').disabled = false;
      $('#unf').disabled = false;
      $('#unf').classList.toggle('busy', !!st.unfRunning);
      if (st.unfRunning) { $('#unf').textContent = '⏹ İptal (' + st.unfDone + ')'; delete $('#unf').dataset.armed; }
      else if (!$('#unf').dataset.armed) { $('#unf').textContent = '🧹 Çıkar'; }
    }
  } else {
    tgl.className = 'stp';
    tgl.textContent = isFollowing ? '▶ Başlat (@' + (st && st.path ? st.path : '?') + ')' : '▶ Başlat';
    ctl.classList.add('off');
  }

  // Mod radyolarını güncelle (çalışmıyorken bile kayıtlı modu göster)
  if (!running) {
    chrome.storage.local.get({ mode: 'nf' }, (s) => {
      document.querySelectorAll('input[name="mode"]').forEach((r) => { r.checked = r.value === s.mode; });
    });
  }
}

function refresh() {
  if (!tab || !canControl) return;
  chrome.tabs.sendMessage(tab.id, { type: 'xfl.getStatus' }, (st) => {
    if (chrome.runtime.lastError) {
      canControl = false;
      setInfo('İçerik betiği yüklenmedi. Sayfayı yenile (F5).', true);
      render(null);
      return;
    }
    render(st);
  });
}

async function init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = tabs[0];
  const url = (tab && tab.url) || '';
  const isX = /^https:\/\/(x\.com|twitter\.com)\//.test(url);

  if (!isX) {
    canControl = false;
    setInfo('Bu sekme x.com değil. X sayfasında çalışır.', true);
    render(null);
    return;
  }

  let pp = null;
  try { pp = new URL(url).pathname; } catch (e) {}
  isFollowing = /^\/[A-Za-z0-9_]{1,15}\/following\/?$/.test(pp || '');

  // İçerik betiği hazır mı?
  chrome.tabs.sendMessage(tab.id, { type: 'xfl.getStatus' }, (st) => {
    if (chrome.runtime.lastError) {
      canControl = false;
      setInfo('Sayfayı yenile (F5) — betik bu sayfa yüklendiğinde eklenmemiş.', true);
      render(null);
      return;
    }
    canControl = true;
    $('#ig-sec').style.display = 'block';
    loadIg();
    if (!isFollowing) {
      setInfo('Kendi "Takip Edilenler" sayfanda (x.com/@handle/following) olmalısın, sonra ▶ Başlat.', true);
    } else if (st && st.running) {
      setInfo('Tarama aktif: @' + (st.owner || new URL(url).pathname.split('/')[1]));
    } else {
      setInfo('Hazır: @' + (pp || '').split('/')[1]);
    }
    render(st);
    if (st && st.running) $('#controls').classList.remove('off');
  });
}

// --- Olaylar ------------------------------------------------------------
$('#toggle').addEventListener('click', () => {
  if (!tab || !canControl) return;
  chrome.tabs.sendMessage(tab.id, { type: 'xfl.getStatus' }, (pre) => {
    if (chrome.runtime.lastError) return;
    const type = pre && pre.running ? 'xfl.stop' : 'xfl.start';
    chrome.tabs.sendMessage(tab.id, { type }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && res.ok === false) {
        if (res.reason === 'not-following-page') setInfo('Kendi /following sayfanda değilsin — taranamadı.', true);
        else if (res.reason === 'owner-mismatch') setInfo(`Dikkat: bu liste @${res.path} kullanıcıya ait görünüyor (@${res.owner} değil).`, true);
        else setInfo('Başlatılamadı: ' + (res.reason || 'bilinmeyen')); // nadir
      }
      refresh();
    });
  });
});

document.querySelectorAll('input[name="mode"]').forEach((r) => {
  r.addEventListener('change', () => {
    if (!tab || !canControl) return;
    chrome.tabs.sendMessage(tab.id, { type: 'xfl.setMode', mode: r.value }, () => {});
  });
});

$('#list').addEventListener('click', () => {
  if (!tab || !canControl) return;
  chrome.tabs.sendMessage(tab.id, { type: 'xfl.toggleList' }, (res) => {
    if (res && res.ok) $('#list').textContent = res.listOpen ? '☰ Listeyi gizle' : '☰ Liste paneli';
  });
});

$('#csv').addEventListener('click', () => {
  if (!tab || !canControl) return;
  chrome.tabs.sendMessage(tab.id, { type: 'xfl.saveCsv' }, (res) => {
    if (res && res.ok) {
      $('#csv').textContent = `⬇ ${res.count} hesap → CSV`;
      setTimeout(() => { $('#csv').textContent = '⬇ CSV'; }, 2500);
    }
  });
});

// Takipten çıkarma: iki aşamalı onay (ilk tık → "Emin misin?" yazısı, 4 sn içinde
// ikinci tık → gerçek istek). runUnfollow yalnızca nf && yoksayılmayan satırları işler.
let unfArmT = null;
$('#unf').addEventListener('click', () => {
  if (!tab || !canControl) return;
  const btn = $('#unf');
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = '⚠️ Emin misin? →';
    clearTimeout(unfArmT);
    unfArmT = setTimeout(() => { delete btn.dataset.armed; btn.textContent = '🧹 Çıkar'; }, 4000);
    return;
  }
  delete btn.dataset.armed; clearTimeout(unfArmT);
  btn.textContent = '🧹 Çıkar';
  chrome.tabs.sendMessage(tab.id, { type: 'xfl.unfollow' }, (res) => {
    if (res && res.ok) { setTimeout(refresh, 500); }
  });
});

// --- 🚫 Yoksayma listesi yönetimi (tarama kapalıyken de çalışır) ---
function renderIgList(list) {
  const box = $('#ig-list');
  $('#ig-n').textContent = String(list.length);
  box.innerHTML = '';
  if (!list.length) {
    const e = document.createElement('div');
    e.className = 'ig-empty';
    e.textContent = 'Liste boş — satırlardaki Ø Yoksay düğmesiyle veya yukarıdan elle ekleyebilirsin.';
    box.appendChild(e);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of list) {
    const row = document.createElement('div'); row.id = 'ig-row';
    const b = document.createElement('b'); b.textContent = '@' + it.h;
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = it.name || '';
    const x = document.createElement('button'); x.className = 'ig-x'; x.textContent = '✕';
    x.title = 'Yoksayma listesinden çıkar'; x.dataset.h = it.h;
    if (!it.name) nm.style.display = 'none';
    row.append(b, nm, x);
    frag.appendChild(row);
  }
  box.appendChild(frag);
}

function loadIg() {
  if (!tab || !canControl) return;
  chrome.tabs.sendMessage(tab.id, { type: 'xfl.ignoreList' }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) return;
    renderIgList(res.list);
  });
}

$('#ig-list').addEventListener('click', (e) => {
  const x = e.target.closest('.ig-x');
  if (!x || !x.dataset.h) return;
  chrome.tabs.sendMessage(tab.id, { type: 'xfl.ignoreRemove', h: x.dataset.h }, (res) => {
    if (res && res.ok) renderIgList(res.list);
  });
});

$('#ig-add').addEventListener('click', () => {
  if (!tab || !canControl) return;
  const inp = $('#ig-input');
  const v = (inp.value || '').trim();
  if (!v) return;
  chrome.tabs.sendMessage(tab.id, { type: 'xfl.ignoreAdd', h: v }, (res) => {
    if (res && res.ok) { inp.value = ''; renderIgList(res.list); }
    else { inp.style.borderColor = '#f4212e'; setTimeout(() => { inp.style.borderColor = ''; }, 1200); }
  });
});
$('#ig-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#ig-add').click(); });

let clearArmT = null;
$('#ig-clear').addEventListener('click', () => {
  if (!tab || !canControl) return;
  const btn = $('#ig-clear');
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    setTimeout(() => btn.classList.remove('armed'), 4000);
    return;
  }
  btn.classList.remove('armed');
  clearTimeout(clearArmT);
  chrome.tabs.sendMessage(tab.id, { type: 'xfl.ignoreClear' }, (res) => {
    if (res && res.ok) renderIgList(res.list);
  });
});

init();
setInterval(refresh, 700);   // canlı istatistik (popup açıkken)
