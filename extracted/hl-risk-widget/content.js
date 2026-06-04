// HL Risk Calculator v1.2 — 4 slots (2 long, 2 short) + autosave + autofill
// Autofill di-hardening: polling waitFor (bukan delay tetap), finder elemen
// berbasis skor multi-strategi, setter nilai dengan verifikasi + fallback ketik,
// dan konfigurasi selektor terpusat (HL_SELECTORS) agar tahan perubahan DOM.
(function () {
  if (document.getElementById('hl-risk-widget')) return;

  // ── STATE ──
  // slots: buy1, buy2, sell1, sell2
  const SLOTS = ['buy1','buy2','sell1','sell2'];
  let state = {
    risk: 10,
    slots: {
      buy1:  { price: '', sl: '' },
      buy2:  { price: '', sl: '' },
      sell1: { price: '', sl: '' },
      sell2: { price: '', sl: '' },
    }
  };

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
    const s = state.slots[id] || { price: '', sl: '' };
    const isBuy  = slotSide(id) === 'buy';
    const colCls = isBuy ? 'hl-col-buy' : 'hl-col-sell';
    const arrow  = isBuy ? '▲' : '▼';
    const fillLabel = isBuy ? `▲ FILL ${slotLabel(id)}` : `▼ FILL ${slotLabel(id)}`;

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

          <!-- RISK -->
          <div id="hl-risk-row">
            <label>RISK $</label>
            <input type="number" id="hl-risk-input" value="${state.risk}" min="0.1" step="0.5" />
            <div class="hl-risk-quick">
              <button class="hl-qbtn" data-risk="5">5</button>
              <button class="hl-qbtn" data-risk="10">10</button>
              <button class="hl-qbtn" data-risk="20">20</button>
              <button class="hl-qbtn" data-risk="50">50</button>
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

  function formatSize(val) {
    if (val === null || isNaN(val) || !isFinite(val)) return '—';
    if (val >= 10000) return val.toFixed(0);
    if (val >= 100)   return val.toFixed(1);
    return val.toFixed(2);
  }

  function updateAllCalc() {
    const risk = parseFloat(document.getElementById('hl-risk-input')?.value) || 0;
    SLOTS.forEach(id => {
      const sl = state.slots[id];
      const size = calcSize(risk, sl.price, sl.sl);
      const el = document.getElementById(`${id}-size`);
      if (el) el.textContent = formatSize(size);
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
    // Kata kunci untuk field Stop Loss (hindari ketabrak dengan TP).
    slHints:    ['stop loss', 'sl price', 'sl trigger', 'stop price', 'trigger', 'stop', 'loss', 'sl'],
  };

  // Batas waktu & interval polling default (ms).
  const WAIT = { timeout: 5000, interval: 120 };

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

  // Kumpulan elemen yang bisa diklik (button, role=button/tab, link, dll).
  function clickables(root) {
    return Array.from((root || document).querySelectorAll(
      'button, [role="button"], [role="tab"], a, [class*="cursor-pointer"], [class*="cursor"]'
    ));
  }

  // Cari elemen klik berdasarkan teks, diberi skor:
  //   exact match (100) > whole-word (75) > substring (55, makin pendek makin tinggi).
  // Mengembalikan kandidat dengan skor tertinggi di atas ambang.
  function findClickableByText(texts, opts = {}) {
    const root = opts.root || document;
    const exclude = opts.exclude || [];
    const wanted = texts.map(norm).filter(Boolean);
    let best = null, bestScore = 0;
    for (const el of clickables(root)) {
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

  // Semua input teks/angka yang terlihat.
  function textInputs(root) {
    return Array.from((root || document).querySelectorAll('input, textarea'))
      .filter(i => !['hidden', 'checkbox', 'radio', 'button', 'submit'].includes(i.type))
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
    ));
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

  // Klik yang meniru interaksi user (mousedown→mouseup→click).
  function clickEl(el) {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
    try { el.click(); } catch (_) {}
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

  async function autofillHL(slotId) {
    const slot  = state.slots[slotId];
    const side  = slotSide(slotId);
    const price = cleanNum(slot.price);
    const sl    = cleanNum(slot.sl);
    const risk  = parseFloat(document.getElementById('hl-risk-input').value) || 0;
    const size  = calcSize(risk, price, sl);

    if (!price || !sl || !size || isNaN(size)) {
      setStatus(`⚠ ${slotLabel(slotId)}: Isi Entry Price & SL dulu`, 'err'); return;
    }

    setStatus(`⏳ Mengisi ${slotLabel(slotId)}...`, 'warn');
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
        setStatus(`⚠ Tab ${side === 'buy' ? 'Buy/Long' : 'Sell/Short'} tak ditemukan — lanjut`, 'warn');
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

      // 4. Field Size (hindari memakai ulang input Price)
      const sizeInput = await waitFor(() =>
        findInput(HL_SELECTORS.sizeHints, { root, avoid: [priceInput] }) ||
        findInput(HL_SELECTORS.sizeHints, { avoid: [priceInput] }), { timeout: 3000 });
      if (sizeInput) {
        if (await setValue(sizeInput, Math.round(size))) done.push('size');
      } else {
        setStatus('⚠ field Size tidak ditemukan — lanjut', 'warn');
      }
      await sleep(120);

      // 5. Aktifkan toggle TP/SL bila belum aktif
      const tpsl = findToggle(HL_SELECTORS.tpslHints, { root }) ||
                   findToggle(HL_SELECTORS.tpslHints);
      if (tpsl && !isToggleOn(tpsl)) { clickEl(tpsl); await sleep(350); }

      // 6. Field Stop Loss (muncul setelah TP/SL aktif; hindari input Price & Size)
      const used = [priceInput, sizeInput].filter(Boolean);
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
        setStatus(
          `✓ ${slotLabel(slotId)} [${done.join(', ')}] · Price=${roundToInt(price)} Size=${Math.round(size)} SL=${roundToInt(sl)}`,
          'ok'
        );
      } else {
        setStatus(`⚠ ${slotLabel(slotId)}: sebagian field gagal terisi — cek manual`, 'err');
      }

    } catch (err) {
      setStatus('⚠ Gagal autofill: ' + err.message, 'err');
      console.error('[HL Widget] autofill error:', err);
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

    // Quick risk
    wrapper.querySelectorAll('.hl-qbtn').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-risk');
        document.getElementById('hl-risk-input').value = val;
        state.risk = parseFloat(val);
        updateAllCalc(); saveState();
      });
    });

    // Copy buttons
    wrapper.querySelectorAll('.hl-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-copy');
        const input = document.getElementById(targetId);
        if (!input) return;
        const n = cleanNum(input.value);
        const isSL = targetId.includes('-sl');
        const copyVal = isNaN(n) ? input.value : (isSL ? String(roundToInt(n)) : String(n));
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
      wrapper.style.left = Math.max(0, Math.min(e.clientX - ox, window.innerWidth  - 400)) + 'px';
      wrapper.style.top  = Math.max(0, Math.min(e.clientY - oy, window.innerHeight -  60)) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; panel.classList.remove('dragging'); });
  }

  // ── INIT ──
  loadState(() => buildWidget());

})();
