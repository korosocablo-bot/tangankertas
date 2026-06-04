// HL Risk Calculator v1.5 — 4 slots (2 long, 2 short) + autosave + autofill
// Autofill di-hardening: polling waitFor (bukan delay tetap), finder elemen
// berbasis skor multi-strategi, setter nilai dengan verifikasi + fallback ketik,
// dan konfigurasi selektor terpusat (HL_SELECTORS) agar tahan perubahan DOM.
// v1.3 fix: kecualikan subtree widget sendiri (#hl-risk-widget) dari semua
// pencarian DOM + guard re-entrancy.
// v1.4 fix: finder memindai SEMUA elemen (tab Buy/Sell bisa <div>/<span>,
// bukan <button>) & klik elemen terdalam (bubbling), clickEl pakai pointer
// events, + window.__hlRiskDiag() untuk diagnosa DOM dari Console.
// v1.5: fitur Risk-Reward (default 1:3, ganti tombol 5/10/20/50) + harga Take
// Profit otomatis per slot & autofill TP; opsi ukuran fill FULL/50% per slot;
// font diperbesar (panel 540px).
(function () {
  if (document.getElementById('hl-risk-widget')) return;

  // ── STATE ──
  // slots: buy1, buy2, sell1, sell2
  const SLOTS = ['buy1','buy2','sell1','sell2'];
  let autofillBusy = false; // guard agar autofill tidak jalan ganda
  let state = {
    risk: 10,
    rr: 3,                 // default Risk-Reward 1:3
    slots: {
      buy1:  { price: '', sl: '', pct: 100 },
      buy2:  { price: '', sl: '', pct: 100 },
      sell1: { price: '', sl: '', pct: 100 },
      sell2: { price: '', sl: '', pct: 100 },
    }
  };

  // Default aman untuk state lama yang tersimpan (tanpa rr / pct).
  function getRR()    { const v = parseFloat(state.rr); return (v && v > 0) ? v : 3; }
  function getPct(id) { const p = state.slots[id] && parseFloat(state.slots[id].pct); return (p === 50) ? 50 : 100; }

  // ── STORAGE ──
  function loadState(cb) {
    try {
      chrome.storage.sync.get(['hl_risk_v2'], (res) => {
        if (res && res.hl_risk_v2) state = { ...state, ...res.hl_risk_v2 };
        cb();
      });
    } catch (e) {
      try { const s = localStorage.getItem('hl_risk_v2'); if (s) state = { ...state, ...JSON.parse(s) }; } catch (_) {}
      cb();
    }
  }

  let saveTimer = null;
  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        chrome.storage.sync.set({ hl_risk_v2: state }, () => {
          const dot = document.getElementById('hl-save-dot');
          if (dot) { dot.classList.add('active'); setTimeout(() => dot.classList.remove('active'), 700); }
        });
      } catch (e) {
        try { localStorage.setItem('hl_risk_v2', JSON.stringify(state)); } catch (_) {}
      }
    }, 350);
  }

  // ── SLOT HELPERS ──
  function slotLabel(id) {
    return { buy1: 'LONG A', buy2: 'LONG B', sell1: 'SHORT A', sell2: 'SHORT B' }[id] || id;
  }
  function slotSide(id) { return id.startsWith('buy') ? 'buy' : 'sell'; }

  // ── HTML BUILDER ──
  function slotHTML(id) {
    const s = state.slots[id] || { price: '', sl: '', pct: 100 };
    const isBuy  = slotSide(id) === 'buy';
    const colCls = isBuy ? 'hl-col-buy' : 'hl-col-sell';
    const arrow  = isBuy ? '▲' : '▼';
    const fillLabel = isBuy ? `▲ FILL ${slotLabel(id)}` : `▼ FILL ${slotLabel(id)}`;
    const pct = getPct(id);

    return `
      <div class="hl-col ${colCls}" data-slot="${id}">
        <div class="hl-col-title">${arrow} ${slotLabel(id)}</div>

        <div class="hl-field">
          <label>Entry Price</label>
          <div class="hl-input-wrap">
            <input type="text" id="${id}-price" placeholder="0.00" value="${s.price}" autocomplete="off" />
            <button class="hl-copy-btn" data-copy="${id}-price">copy</button>
          </div>
        </div>

        <div class="hl-field">
          <label>Stop Loss</label>
          <div class="hl-input-wrap">
            <input type="text" id="${id}-sl" placeholder="0.00" value="${s.sl}" autocomplete="off" />
            <button class="hl-copy-btn" data-copy="${id}-sl">copy</button>
          </div>
        </div>

        <div class="hl-size-result">
          <div class="hl-size-label">Position Size</div>
          <div>
            <span class="hl-size-value" id="${id}-size">—</span>
            <span class="hl-size-unit">USDC</span>
          </div>
        </div>

        <div class="hl-tp-result">
          <div class="hl-size-label">Take Profit <span class="hl-tp-rr" id="${id}-rrlbl">1:${getRR()}</span></div>
          <div class="hl-input-wrap">
            <span class="hl-tp-value" id="${id}-tp">—</span>
            <button class="hl-copy-btn" data-copy="${id}-tp">copy</button>
          </div>
        </div>

        <div class="hl-pct-toggle">
          <button class="hl-pctbtn ${pct === 100 ? 'active' : ''}" data-slot="${id}" data-pct="100">FULL</button>
          <button class="hl-pctbtn ${pct === 50  ? 'active' : ''}" data-slot="${id}" data-pct="50">50%</button>
        </div>

        <button class="hl-autofill-btn ${colCls}-fill" id="btn-autofill-${id}">
          ${fillLabel}
        </button>
      </div>
    `;
  }

  function buildWidget() {
    const wrapper = document.createElement('div');
    wrapper.id = 'hl-risk-widget';

    wrapper.innerHTML = `
      <div id="hl-widget-panel">
        <div id="hl-widget-header">
          <span id="hl-widget-title">⬡ HL RISK <span id="hl-save-dot"></span></span>
          <div id="hl-widget-controls">
            <button class="hl-ctrl-btn" id="hl-btn-minimize" title="Minimize">—</button>
            <button class="hl-ctrl-btn" id="hl-btn-close" title="Close">✕</button>
          </div>
        </div>

        <div id="hl-widget-body">

          <!-- RISK + RR -->
          <div id="hl-risk-row">
            <label>RISK $</label>
            <input type="number" id="hl-risk-input" value="${state.risk}" min="0.1" step="0.5" />
            <label class="hl-rr-label">RR 1:</label>
            <input type="number" id="hl-rr-input" value="${getRR()}" min="0.5" step="0.5" />
            <div class="hl-rr-quick">
              <button class="hl-rrbtn" data-rr="1">1</button>
              <button class="hl-rrbtn" data-rr="2">2</button>
              <button class="hl-rrbtn" data-rr="3">3</button>
              <button class="hl-rrbtn" data-rr="5">5</button>
            </div>
          </div>

          <!-- SECTION HEADERS -->
          <div id="hl-section-headers">
            <div class="hl-section-label buy-label">▲ LONG</div>
            <div class="hl-section-label sell-label">▼ SHORT</div>
          </div>

          <!-- ROW 1: buy1 | sell1 -->
          <div class="hl-row">
            ${slotHTML('buy1')}
            ${slotHTML('sell1')}
          </div>

          <!-- DIVIDER -->
          <div class="hl-row-divider"></div>

          <!-- ROW 2: buy2 | sell2 -->
          <div class="hl-row">
            ${slotHTML('buy2')}
            ${slotHTML('sell2')}
          </div>

          <!-- STATUS -->
          <div id="hl-status-bar">— siap —</div>
        </div>
      </div>
    `;

    document.body.appendChild(wrapper);
    attachEvents(wrapper);
    updateAllCalc();
    updateAutofillButtons();
  }

  // ── CALC ──
  function cleanNum(val) {
    return parseFloat(String(val).replace(/,/g, '').replace(/\s/g, ''));
  }
  function roundToInt(val) { return Math.round(val); }

  function calcSize(risk, entry, sl) {
    const e = cleanNum(entry), s = cleanNum(sl);
    if (!e || !s || isNaN(e) || isNaN(s) || e === s) return null;
    return risk / (Math.abs(e - s) / e);
  }

  // Take Profit dari Risk-Reward: TP = entry ± RR × |entry − SL|.
  // Long (buy): TP di atas entry. Short (sell): TP di bawah entry.
  function calcTP(side, entry, sl, rr) {
    const e = cleanNum(entry), s = cleanNum(sl);
    if (!e || !s || isNaN(e) || isNaN(s) || e === s || !rr) return null;
    const riskPerUnit = Math.abs(e - s);
    return side === 'buy' ? e + rr * riskPerUnit : e - rr * riskPerUnit;
  }

  function formatSize(val) {
    if (val === null || isNaN(val) || !isFinite(val)) return '—';
    if (val >= 10000) return val.toFixed(0);
    if (val >= 100)   return val.toFixed(1);
    return val.toFixed(2);
  }

  // Format harga adaptif sesuai besaran (BTC vs koin desimal kecil).
  function formatPrice(val) {
    if (val === null || isNaN(val) || !isFinite(val)) return '—';
    const a = Math.abs(val);
    if (a >= 1000) return val.toFixed(1);
    if (a >= 1)    return val.toFixed(2);
    if (a >= 0.01) return val.toFixed(4);
    return val.toFixed(6);
  }

  function updateAllCalc() {
    const risk = parseFloat(document.getElementById('hl-risk-input')?.value) || 0;
    const rr   = getRR();
    SLOTS.forEach(id => {
      const sl   = state.slots[id];
      const size = calcSize(risk, sl.price, sl.sl);
      const tp   = calcTP(slotSide(id), sl.price, sl.sl, rr);
      const sizeEl = document.getElementById(`${id}-size`);
      const tpEl   = document.getElementById(`${id}-tp`);
      const rrLbl  = document.getElementById(`${id}-rrlbl`);
      if (sizeEl) sizeEl.textContent = formatSize(size);
      if (tpEl)   tpEl.textContent   = formatPrice(tp);
      if (rrLbl)  rrLbl.textContent  = `1:${rr}`;
    });
  }

  // ── STATUS ──
  function setStatus(msg, type) {
    const el = document.getElementById('hl-status-bar');
    if (!el) return;
    el.textContent = msg;
    el.className = type || '';
    if (type === 'ok') setTimeout(() => { el.textContent = '— siap —'; el.className = ''; }, 3000);
  }

  function isHyperliquid() { return location.hostname.includes('hyperliquid.xyz'); }

  function updateAutofillButtons() {
    const onHL = isHyperliquid();
    SLOTS.forEach(id => {
      const btn = document.getElementById(`btn-autofill-${id}`);
      if (!btn) return;
      btn.disabled = !onHL;
      btn.title = onHL ? '' : 'Hanya berfungsi di app.hyperliquid.xyz';
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  AUTOFILL — hardened against Hyperliquid DOM changes
  // ════════════════════════════════════════════════════════════════
  //
  //  Semua heuristik pencocokan dikumpulkan di HL_SELECTORS supaya
  //  kalau Hyperliquid mengubah teks/label, cukup edit SATU tempat ini.
  const HL_SELECTORS = {
    // Teks tab Buy/Long & Sell/Short (urut dari paling spesifik).
    buyTab:    ['buy / long', 'buy/long', 'long', 'buy'],
    sellTab:   ['sell / short', 'sell/short', 'short', 'sell'],
    limitTab:  ['limit'],
    // Kata kunci untuk menemukan input lewat placeholder / aria-label /
    // name / id / teks label di sekitarnya.
    priceHints: ['price (usdc)', 'price', 'harga'],
    sizeHints:  ['size', 'amount', 'quantity', 'qty', 'jumlah', 'ukuran'],
    // Teks toggle/checkbox untuk mengaktifkan TP/SL.
    tpslHints:  ['tp/sl', 'tp / sl', 'tpsl', 'take profit / stop loss', 'stop loss', 'take profit'],
    // Kata kunci untuk field Take Profit (hindari ketabrak dengan SL).
    tpHints:    ['tp price', 'take profit', 'tp trigger', 'profit', 'gain', 'tp'],
    // Kata kunci untuk field Stop Loss (hindari ketabrak dengan TP).
    slHints:    ['sl price', 'stop loss', 'sl trigger', 'stop price', 'loss', 'stop', 'sl'],
  };

  // Batas waktu & interval polling default (ms).
  const WAIT = { timeout: 5000, interval: 120 };

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // PENTING: jangan pernah menjaring elemen widget kita sendiri.
  // Tombol "FILL LONG A" mengandung kata "long" dan input kita ber-id
  // seperti "buy1-price"/"buy1-sl", sehingga tanpa filter ini script bisa
  // salah mengklik tombolnya sendiri (rekursif) atau mengisi field sendiri.
  function notInWidget(el) {
    const w = document.getElementById('hl-risk-widget');
    return !w || !w.contains(el);
  }

  // Normalisasi teks: rapikan whitespace + lowercase.
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }

  // Pecah teks jadi token kata (alfanumerik) untuk pencocokan "whole word".
  function tokens(s) { return norm(s).split(/[^a-z0-9]+/).filter(Boolean); }

  // Polling: jalankan fn() berulang sampai mengembalikan nilai truthy
  // atau timeout. Inilah pengganti utama dari sleep() berdurasi tetap,
  // sehingga autofill menunggu elemen benar-benar siap.
  async function waitFor(fn, opts = {}) {
    const { timeout = WAIT.timeout, interval = WAIT.interval } = opts;
    const start = Date.now();
    for (;;) {
      let val = null;
      try { val = fn(); } catch (_) { val = null; }
      if (val) return val;
      if (Date.now() - start >= timeout) return null;
      await sleep(interval);
    }
  }

  // Elemen dianggap "terlihat" bila tampil di layar & tidak disabled.
  function isVisible(el) {
    if (!el || el.disabled) return false;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (el.offsetParent === null && style.position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Cari elemen yang teksnya cocok dengan salah satu `texts`.
  // Memindai SEMUA elemen (bukan hanya <button>), karena tab Buy/Sell di
  // Hyperliquid sering berupa <div>/<span> tanpa atribut tombol. Dipilih
  // elemen TERKECIL (paling dalam) dengan skor tertinggi — meng-klik elemen
  // ini tetap memicu handler induknya lewat event bubbling (React delegation).
  //   exact (100) > whole-word (80) > substring (55).
  function findClickableByText(texts, opts = {}) {
    const root = (opts.root && opts.root.querySelectorAll) ? opts.root : document;
    const exclude = opts.exclude || [];
    const wanted = texts.map(norm).filter(Boolean);
    let best = null, bestScore = 0, bestLen = Infinity;
    for (const el of root.querySelectorAll('*')) {
      if (exclude.includes(el) || !notInWidget(el)) continue;
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG' || tag === 'PATH') continue;
      const t = norm(el.textContent);
      if (!t || t.length > 28) continue; // hindari kontainer besar
      if (!isVisible(el)) continue;
      const toks = tokens(t);
      let score = 0;
      for (const w of wanted) {
        if (t === w) score = Math.max(score, 100);
        else if (toks.includes(w)) score = Math.max(score, 80);
        else if (t.includes(w)) score = Math.max(score, 55);
      }
      if (score <= 0) continue;
      // skor lebih tinggi menang; jika seri, teks lebih pendek (lebih "dalam") menang.
      if (score > bestScore || (score === bestScore && t.length < bestLen)) {
        bestScore = score; best = el; bestLen = t.length;
      }
    }
    return bestScore >= 55 ? best : null;
  }

  // (lama, tak dipakai lagi) — disimpan sebagai referensi internal.
  function _legacyFindClickableByText(texts, opts = {}) {
    const root = opts.root || document;
    const exclude = opts.exclude || [];
    const wanted = texts.map(norm).filter(Boolean);
    let best = null, bestScore = 0;
    const list = Array.from((root || document).querySelectorAll(
      'button, [role="button"], [role="tab"], a, [class*="cursor-pointer"]')).filter(notInWidget);
    for (const el of list) {
      if (exclude.includes(el) || !isVisible(el)) continue;
      const t = norm(el.textContent);
      if (!t || t.length > 40) continue; // hindari kontainer besar
      const toks = tokens(t);
      let score = 0;
      for (const w of wanted) {
        if (t === w) score = Math.max(score, 100);
        else if (toks.includes(w)) score = Math.max(score, 75);
        else if (t.includes(w)) score = Math.max(score, 55 - Math.min(20, t.length - w.length));
      }
      if (score > 0) score += Math.max(0, 15 - t.length); // sedikit favoritkan teks ringkas
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return bestScore >= 55 ? best : null;
  }

  // Susun "konteks" sebuah input dari placeholder, aria-label, name, id,
  // <label for>, aria-label leluhur, dan teks kontainer terdekat (jika pendek).
  function inputContext(inp) {
    const parts = [
      inp.placeholder,
      inp.getAttribute('aria-label'),
      inp.getAttribute('name'),
      inp.id,
    ];
    if (inp.id) {
      try {
        const lab = document.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
        if (lab) parts.push(lab.textContent);
      } catch (_) {}
    }
    let node = inp.parentElement, hops = 0;
    while (node && hops < 4) {
      if (node.getAttribute) parts.push(node.getAttribute('aria-label'));
      hops++; node = node.parentElement;
    }
    const near = inp.closest('label, [class*="row"], [class*="field"], div, tr');
    if (near) {
      const t = near.textContent || '';
      if (t.length < 80) parts.push(t);
    }
    return norm(parts.filter(Boolean).join(' '));
  }

  // Semua input teks/angka yang terlihat (di luar widget sendiri).
  function textInputs(root) {
    return Array.from((root || document).querySelectorAll('input, textarea'))
      .filter(i => !['hidden', 'checkbox', 'radio', 'button', 'submit'].includes(i.type))
      .filter(notInWidget)
      .filter(isVisible);
  }

  // Cari input terbaik berdasarkan kata kunci konteks, lewati yang sudah dipakai.
  function findInput(hints, opts = {}) {
    const root = opts.root || document;
    const avoid = opts.avoid || [];
    const wanted = hints.map(norm).filter(Boolean);
    let best = null, bestScore = 0;
    for (const inp of textInputs(root)) {
      if (avoid.includes(inp)) continue;
      const ctx = inputContext(inp);
      const toks = tokens(ctx);
      let score = 0;
      for (const w of wanted) {
        if (toks.includes(w)) score = Math.max(score, 80);
        else if (ctx.includes(w)) score = Math.max(score, 55);
      }
      if (score > bestScore) { bestScore = score; best = inp; }
    }
    return bestScore >= 55 ? best : null;
  }

  // Cari checkbox/toggle berdasarkan teks di sekitarnya.
  function findToggle(hints, opts = {}) {
    const root = opts.root || document;
    const wanted = hints.map(norm).filter(Boolean);
    const boxes = Array.from(root.querySelectorAll(
      'input[type="checkbox"], [role="checkbox"], [role="switch"]'
    )).filter(notInWidget);
    for (const cb of boxes) {
      const ctx = norm((cb.closest('label, div, tr')?.textContent || '') + ' ' +
                       (cb.getAttribute('aria-label') || ''));
      if (wanted.some(w => ctx.includes(w))) return cb;
    }
    return null;
  }

  function isToggleOn(cb) {
    if (typeof cb.checked === 'boolean' && cb.type) return cb.checked;
    return cb.getAttribute('aria-checked') === 'true';
  }

  // Klik yang meniru interaksi user selengkap mungkin:
  // pointerdown → mousedown → pointerup → mouseup → click.
  // Sebagian komponen React hanya bereaksi pada pointer events.
  // Catatan: pakai SATU sumber 'click' saja (el.click() bila tersedia,
  // selain itu dispatch manual) agar toggle tidak ter-klik dua kali.
  function clickEl(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', opts));
  }

  // Set value lewat setter prototype (React-friendly) + dispatch event.
  function reactSetRaw(el, val) {
    const proto = el instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, val); else el.value = val;
  }

  // Set nilai input secara robust + VERIFIKASI. Mengembalikan true bila
  // nilai akhirnya benar-benar terisi. Bila cara cepat gagal (mis. input
  // butuh keystroke), fallback ke simulasi ketik per-karakter.
  async function setValue(el, value) {
    const target = String(value);
    el.focus();
    try { el.select(); } catch (_) {}

    // Percobaan 1: clear → set langsung → input/change.
    reactSetRaw(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    reactSetRaw(el, target);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: target, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(70);
    if (norm(el.value) === norm(target)) { el.blur(); return true; }

    // Percobaan 2: simulasi ketik per-karakter (untuk input yang
    // mendengarkan keydown/keyup atau memvalidasi tiap keystroke).
    reactSetRaw(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    for (const ch of target) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      reactSetRaw(el, el.value + ch);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      await sleep(15);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(50);
    el.blur();
    return norm(el.value) === norm(target);
  }

  // Temukan kontainer "order form": leluhur bersama yang memuat tab Buy & Sell.
  // Pencarian discope ke sini lebih dulu untuk mengurangi salah-cocok,
  // dengan fallback ke seluruh document.
  function findOrderFormRoot() {
    const buy  = findClickableByText(HL_SELECTORS.buyTab);
    const sell = findClickableByText(HL_SELECTORS.sellTab);
    if (buy && sell) {
      let a = buy;
      while (a && !a.contains(sell)) a = a.parentElement;
      if (a) return a;
    }
    return document;
  }

  // ── DIAGNOSTIK ──
  // Jalankan window.__hlRiskDiag() di Console untuk melihat apa saja yang
  // "terlihat" oleh script: kandidat tab Buy/Sell/Limit serta semua input.
  // Kirim hasilnya ke pengembang untuk menyetel HL_SELECTORS bila perlu.
  function hlDiag() {
    const seen = new Set();
    const clickCandidates = [];
    for (const el of document.querySelectorAll('*')) {
      if (!notInWidget(el)) continue;
      const t = norm(el.textContent);
      if (!t || t.length > 24) continue;
      if (!/\b(buy|sell|long|short|limit|market|tp\/?sl|stop|profit)\b/.test(t)) continue;
      if (!isVisible(el)) continue;
      const key = el.tagName + '|' + t;
      if (seen.has(key)) continue;
      seen.add(key);
      clickCandidates.push({ tag: el.tagName, role: el.getAttribute('role') || '', text: t,
                             cls: (el.className || '').toString().slice(0, 60) });
    }
    const inputs = textInputs().map(i => ({
      ph: i.placeholder || '', aria: i.getAttribute('aria-label') || '',
      name: i.name || '', id: i.id || '', ctx: inputContext(i).slice(0, 80),
    }));
    const toggles = Array.from(document.querySelectorAll(
      'input[type="checkbox"], [role="checkbox"], [role="switch"]'))
      .filter(notInWidget)
      .map(cb => ({ text: norm(cb.closest('label, div, tr')?.textContent || '').slice(0, 60),
                    aria: cb.getAttribute('aria-label') || '' }));
    console.log('%c[HL Risk] ── DIAGNOSTIK ──', 'color:#26d0ce;font-weight:bold');
    console.log('[HL Risk] Kandidat tab/teks (buy/sell/limit/dll):', clickCandidates);
    console.log('[HL Risk] Input terlihat:', inputs);
    console.log('[HL Risk] Toggle/checkbox:', toggles);
    return { clickCandidates, inputs, toggles };
  }
  try { window.__hlRiskDiag = hlDiag; } catch (_) {}

  async function autofillHL(slotId) {
    if (autofillBusy) return;            // cegah klik ganda / re-entrancy
    const slot  = state.slots[slotId];
    const side  = slotSide(slotId);
    const price = cleanNum(slot.price);
    const sl    = cleanNum(slot.sl);
    const rr    = getRR();
    const pct   = getPct(slotId);
    const risk  = parseFloat(document.getElementById('hl-risk-input').value) || 0;
    const fullSize = calcSize(risk, price, sl);
    const size  = (fullSize != null) ? fullSize * (pct / 100) : null;
    const tp    = calcTP(side, price, sl, rr);

    if (!price || !sl || !size || isNaN(size)) {
      setStatus(`⚠ ${slotLabel(slotId)}: Isi Entry Price & SL dulu`, 'err'); return;
    }

    autofillBusy = true;
    setStatus(`⏳ Mengisi ${slotLabel(slotId)} (${pct}%)...`, 'warn');
    const done = []; // langkah yang berhasil, untuk laporan status

    try {
      // Scope pencarian ke kontainer order form bila ketemu, lalu fallback document.
      const root = findOrderFormRoot();
      const sideTexts = side === 'buy' ? HL_SELECTORS.buyTab : HL_SELECTORS.sellTab;

      // 1. Tab Buy/Long atau Sell/Short
      const sideTab = await waitFor(() =>
        findClickableByText(sideTexts, { root }) || findClickableByText(sideTexts),
        { timeout: 4000 });
      if (sideTab) {
        clickEl(sideTab); done.push('side'); await sleep(250);
      } else {
        hlDiag(); // dump kandidat ke Console untuk diagnosa
        setStatus(`⚠ Tab ${side === 'buy' ? 'Buy/Long' : 'Sell/Short'} tak ditemukan — buka Console, jalankan __hlRiskDiag()`, 'warn');
      }

      // 2. Tab Limit
      const limitTab = findClickableByText(HL_SELECTORS.limitTab, { root }) ||
                       findClickableByText(HL_SELECTORS.limitTab);
      if (limitTab) { clickEl(limitTab); done.push('limit'); await sleep(250); }

      // 3. Field Price (tunggu sampai muncul, lalu set + verifikasi)
      const priceInput = await waitFor(() =>
        findInput(HL_SELECTORS.priceHints, { root }) || findInput(HL_SELECTORS.priceHints));
      if (!priceInput) throw new Error('field Price tidak ditemukan');
      if (await setValue(priceInput, roundToInt(price))) done.push('price');
      await sleep(120);

      // 4. Field Size — pakai fraksi terpilih (FULL / 50%)
      const sizeInput = await waitFor(() =>
        findInput(HL_SELECTORS.sizeHints, { root, avoid: [priceInput] }) ||
        findInput(HL_SELECTORS.sizeHints, { avoid: [priceInput] }), { timeout: 3000 });
      if (sizeInput) {
        if (await setValue(sizeInput, Math.round(size))) done.push(`size${pct}%`);
      } else {
        setStatus('⚠ field Size tidak ditemukan — lanjut', 'warn');
      }
      await sleep(120);

      // 5. Aktifkan toggle TP/SL bila belum aktif
      const tpsl = findToggle(HL_SELECTORS.tpslHints, { root }) ||
                   findToggle(HL_SELECTORS.tpslHints);
      if (tpsl && !isToggleOn(tpsl)) { clickEl(tpsl); await sleep(350); }

      // 6. Field Take Profit (dari RR) — hindari input Price & Size
      let tpInput = null;
      if (tp != null && isFinite(tp) && tp > 0) {
        const avoidTP = [priceInput, sizeInput].filter(Boolean);
        tpInput = await waitFor(() =>
          findInput(HL_SELECTORS.tpHints, { root, avoid: avoidTP }) ||
          findInput(HL_SELECTORS.tpHints, { avoid: avoidTP }), { timeout: 3000 });
        if (tpInput) {
          if (await setValue(tpInput, roundToInt(tp))) done.push('tp');
        } else {
          setStatus('⚠ field Take Profit tidak ditemukan — lanjut', 'warn');
        }
        await sleep(120);
      }

      // 7. Field Stop Loss (hindari Price, Size, dan TP)
      const used = [priceInput, sizeInput, tpInput].filter(Boolean);
      const slInput = await waitFor(() =>
        findInput(HL_SELECTORS.slHints, { root, avoid: used }) ||
        findInput(HL_SELECTORS.slHints, { avoid: used }), { timeout: 3000 });
      if (slInput) {
        if (await setValue(slInput, roundToInt(sl))) done.push('sl');
      } else {
        setStatus('⚠ field Stop Loss tidak ditemukan', 'warn');
      }

      // Laporan akhir: tampilkan langkah yang berhasil.
      if (done.includes('price')) {
        const tpTxt = (tp != null) ? ` TP=${roundToInt(tp)}` : '';
        setStatus(
          `✓ ${slotLabel(slotId)} ${pct}% [${done.join(', ')}] · P=${roundToInt(price)} Sz=${Math.round(size)}${tpTxt} SL=${roundToInt(sl)}`,
          'ok'
        );
      } else {
        setStatus(`⚠ ${slotLabel(slotId)}: sebagian field gagal terisi — cek manual`, 'err');
      }

    } catch (err) {
      setStatus('⚠ Gagal autofill: ' + err.message, 'err');
      console.error('[HL Widget] autofill error:', err);
    } finally {
      autofillBusy = false;             // selalu lepas guard, sukses/gagal
    }
  }

  // ── COPY BUTTON HELPER ──
  function doCopy(val, btn) {
    navigator.clipboard.writeText(val).then(() => {
      btn.textContent = '✓'; btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1200);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = val; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      btn.textContent = '✓'; btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1200);
    });
  }

  // ── ATTACH EVENTS ──
  function attachEvents(wrapper) {

    // Slot inputs
    SLOTS.forEach(id => {
      ['price', 'sl'].forEach(field => {
        const el = document.getElementById(`${id}-${field}`);
        if (!el) return;
        el.addEventListener('input', () => {
          state.slots[id][field] = el.value;
          updateAllCalc(); saveState();
        });
      });
    });

    // Risk
    document.getElementById('hl-risk-input').addEventListener('input', (e) => {
      state.risk = parseFloat(e.target.value) || 0;
      updateAllCalc(); saveState();
    });

    // RR (Risk-Reward) input
    document.getElementById('hl-rr-input').addEventListener('input', (e) => {
      state.rr = parseFloat(e.target.value) || 0;
      updateAllCalc(); saveState();
    });

    // Quick RR presets (mengganti tombol 5/10/20/50 lama)
    wrapper.querySelectorAll('.hl-rrbtn').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-rr');
        document.getElementById('hl-rr-input').value = val;
        state.rr = parseFloat(val);
        updateAllCalc(); saveState();
      });
    });

    // Toggle ukuran fill: FULL (100%) / 50%
    wrapper.querySelectorAll('.hl-pctbtn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id  = btn.getAttribute('data-slot');
        const pct = parseFloat(btn.getAttribute('data-pct'));
        if (!state.slots[id]) return;
        state.slots[id].pct = pct;
        // perbarui status aktif kedua tombol di slot ini
        wrapper.querySelectorAll(`.hl-pctbtn[data-slot="${id}"]`).forEach(b => {
          b.classList.toggle('active', parseFloat(b.getAttribute('data-pct')) === pct);
        });
        saveState();
      });
    });

    // Copy buttons (mendukung input maupun span seperti TP)
    wrapper.querySelectorAll('.hl-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-copy');
        const el = document.getElementById(targetId);
        if (!el) return;
        const raw = ('value' in el && el.value !== undefined && el.tagName === 'INPUT')
          ? el.value : el.textContent;
        const n = cleanNum(raw);
        const isSL = targetId.includes('-sl');
        const copyVal = isNaN(n) ? String(raw).trim() : (isSL ? String(roundToInt(n)) : String(n));
        doCopy(copyVal, btn);
      });
    });

    // Autofill buttons
    SLOTS.forEach(id => {
      const btn = document.getElementById(`btn-autofill-${id}`);
      if (btn) btn.addEventListener('click', () => autofillHL(id));
    });

    // Minimize
    document.getElementById('hl-btn-minimize').addEventListener('click', () => {
      const panel = document.getElementById('hl-widget-panel');
      const min = panel.classList.toggle('minimized');
      document.getElementById('hl-btn-minimize').textContent = min ? '□' : '—';
    });

    // Close
    document.getElementById('hl-btn-close').addEventListener('click', () => {
      wrapper.style.display = 'none';
      setTimeout(() => { wrapper.style.display = ''; }, 5000);
    });

    // Drag
    const header = document.getElementById('hl-widget-header');
    const panel  = document.getElementById('hl-widget-panel');
    let dragging = false, ox = 0, oy = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('hl-ctrl-btn')) return;
      dragging = true; panel.classList.add('dragging');
      const r = wrapper.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      wrapper.style.right = 'auto'; wrapper.style.bottom = 'auto';
      wrapper.style.left = Math.max(0, Math.min(e.clientX - ox, window.innerWidth  - 480)) + 'px';
      wrapper.style.top  = Math.max(0, Math.min(e.clientY - oy, window.innerHeight -  60)) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; panel.classList.remove('dragging'); });
  }

  // ── INIT ──
  loadState(() => buildWidget());

})();
