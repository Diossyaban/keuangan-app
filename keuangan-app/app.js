'use strict';

/* =========================================================
   Konfigurasi
   ========================================================= */
const API_URL = 'https://script.google.com/macros/s/AKfycbwKdHF2NeZsCiwrqg8mcWqQwMXp5aTkjFIB55dx8Gx2ryvvL_ysWR--88p7uHA9wviO/exec';

// Kosongkan bila Apps Script tidak memakai token. Harus sama dengan API_TOKEN di code.gs.
const API_TOKEN = '';

const STORAGE_PREFS = 'keuangan:prefs:v2';
const STORAGE_SNAPSHOT = 'keuangan:snapshot:v2';
const PAGE_SIZE = 30;

/* =========================================================
   State
   ========================================================= */
const state = {
  income: [],
  expense: [],
  cats: { income: [], expense: [] },
  wallets: [],
  has: { category: true, note: true, source: true },
  today: localISO(new Date()),
  period: 'bulan',
  range: { start: '', end: '' },
  hideAmounts: false,
  filters: { q: '', type: 'semua', cat: 'semua', wallet: 'semua' },
  limit: PAGE_SIZE,
  view: [],
  form: { type: 'expense', editing: null, category: '', wallet: '', busy: false },
  action: null,
  confirmResolve: null,
  loading: false,
  hasData: false,
  offline: false,
  error: '',
  lastSync: 0
};

/* =========================================================
   Util dasar
   ========================================================= */
const $ = (id) => document.getElementById(id);
const nfID = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function formatRupiah(value) {
  const n = Number(value) || 0;
  const sign = n < 0 ? '-' : '';
  return sign + 'Rp ' + nfID.format(Math.abs(n));
}

function formatNumber(value) {
  return nfID.format(Number(value) || 0);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localISO(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function fromISO(iso) {
  const parts = String(iso || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return new Date(NaN);
  return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
}

function addDaysISO(iso, days) {
  const d = fromISO(iso);
  d.setDate(d.getDate() + days);
  return localISO(d);
}

function diffDays(startISO, endISO) {
  const a = fromISO(startISO);
  const b = fromISO(endISO);
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

function formatDateShort(iso) {
  const d = fromISO(iso);
  if (isNaN(d)) return String(iso || '-');
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateLong(iso) {
  const d = fromISO(iso);
  if (isNaN(d)) return String(iso || '-');
  return d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function formatMonthLong(iso) {
  const d = fromISO(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
}

function sum(list) {
  return (list || []).reduce((total, item) => {
    const value = item && typeof item === 'object' ? Number(item.amount) : Number(item);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function debounce(fn, wait) {
  let timer = null;
  return function debounced() {
    const args = arguments;
    const context = this;
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(context, args), wait);
  };
}

/* =========================================================
   Gaya kategori (ikon + warna deterministik)
   ========================================================= */
const CAT_STYLES = {
  'gaji': ['💼', '#0f7a5f'],
  'bonus': ['🎁', '#2f8f6a'],
  'usaha': ['🏪', '#a67b5b'],
  'investasi': ['📈', '#4f6fa5'],
  'hadiah': ['🎀', '#b5566b'],
  'makanan & minuman': ['🍚', '#c2743f'],
  'makanan': ['🍚', '#c2743f'],
  'transportasi': ['🚌', '#4f7fa8'],
  'belanja': ['🛍️', '#9b5f74'],
  'tagihan & utilitas': ['🧾', '#7a6a8f'],
  'tagihan': ['🧾', '#7a6a8f'],
  'hiburan': ['🎬', '#7c6bd6'],
  'kesehatan': ['🩺', '#0f8b8b'],
  'pendidikan': ['📚', '#5b7f4f'],
  'cicilan': ['🏦', '#8a5a3a'],
  'donasi & sosial': ['🤝', '#4d8a63'],
  'donasi': ['🤝', '#4d8a63'],
  'tabungan': ['🐖', '#2f8f6a'],
  'keluarga': ['🏡', '#b07d3f'],
  'olahraga': ['🏃', '#4f7fa8'],
  'pulsa & internet': ['📶', '#4f7fa8'],
  'lainnya': ['📦', '#8b7c6f']
};

const PALETTE = ['#6b4423', '#a67b5b', '#0f8b8b', '#7c6bd6', '#c98a4b', '#4d8a63', '#b5566b', '#4f7fa8', '#8a5a3a', '#5b7f4f'];

function catStyle(name, type) {
  const key = String(name || '').trim().toLowerCase();
  if (CAT_STYLES[key]) return { icon: CAT_STYLES[key][0], color: CAT_STYLES[key][1] };
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) % 9973;
  return {
    icon: type === 'income' ? '💰' : '💸',
    color: PALETTE[hash % PALETTE.length]
  };
}

/* =========================================================
   Kantong dana
   ========================================================= */
function normaliseWallet(wallet) {
  if (!wallet) return null;
  const nama = String(wallet.nama || '').trim();
  if (!nama) return null;
  return {
    id: String(wallet.id || '').trim(),
    nama: nama,
    tipe: String(wallet.tipe || '').trim() || 'Lainnya',
    saldoAwal: Number(wallet.saldoAwal) || 0,
    saldo: Number(wallet.saldo) || 0,
    icon: String(wallet.icon || '').trim() || '💰',
    status: String(wallet.status || '').trim() || 'Aktif',
    catatan: String(wallet.catatan || '').trim()
  };
}

function activeWallets() {
  return state.wallets.filter((wallet) => String(wallet.status || '').toLowerCase() !== 'nonaktif');
}

function walletTotal() {
  return activeWallets().reduce((total, wallet) => total + (Number(wallet.saldo) || 0), 0);
}

function mostUsedWallet(type) {
  const countIn = (list) => {
    const counts = new Map();
    list.forEach((tx) => {
      const name = String(tx.source || '').trim();
      if (!name) return;
      counts.set(name, (counts.get(name) || 0) + 1);
    });
    if (!counts.size) return '';
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
  };

  const preferred = type === 'income' ? countIn(state.income)
    : type === 'expense' ? countIn(state.expense)
    : '';
  const best = preferred || countIn(state.income.concat(state.expense));
  if (!best) return '';
  return activeWallets().some((wallet) => wallet.nama === best) ? best : '';
}

/* =========================================================
   API
   ========================================================= */
async function api(action, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, token: API_TOKEN, payload: payload || {} }),
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store'
    });

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error('Server mengirim respons yang tidak dikenali. Pastikan Web App dideploy ulang dengan akses "Siapa saja".');
    }

    if (!json || json.ok !== true) {
      throw new Error((json && json.error) || 'Permintaan ditolak server.');
    }
    return json.data;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('Koneksi terlalu lama. Periksa internet lalu coba lagi.');
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   Init
   ========================================================= */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

async function init() {
  paintToday();
  loadPrefs();
  applyPrefs();
  bindEvents();
  setupResizeObserver();
  registerServiceWorker();

  try {
    await loadData({ silent: false });
  } finally {
    revealApp();
  }
}

function revealApp() {
  $('app').hidden = false;
  const splash = $('splash');
  splash.classList.add('is-hidden');
  setTimeout(() => splash.remove(), 450);
}

function paintToday() {
  const now = new Date();
  $('todayLabel').textContent = now.toLocaleDateString('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

/* =========================================================
   Data load / simpan snapshot
   ========================================================= */
async function loadData(options) {
  const silent = Boolean(options && options.silent);
  if (state.loading) return;
  state.loading = true;

  const refreshBtn = $('btnRefresh');
  if (refreshBtn) refreshBtn.classList.add('is-busy');

  try {
    const data = await api('bootstrap');
    applyPayload(data);
    state.offline = false;
    state.error = '';
    state.hasData = true;
    state.lastSync = Date.now();
    saveSnapshot(data);
  } catch (err) {
    state.error = (err && err.message) || 'Gagal memuat data.';
    const snapshot = readSnapshot();
    if (snapshot && !state.hasData) {
      applyPayload(snapshot.data);
      state.offline = true;
      state.hasData = true;
      state.lastSync = snapshot.at;
    }
    if (silent && state.hasData) showToast(state.error, 'error', 4200);
  } finally {
    state.loading = false;
    if (refreshBtn) refreshBtn.classList.remove('is-busy');
    renderAll();
  }
}

function normaliseTransaction(tx) {
  if (!tx) return null;
  const type = tx.type === 'income' ? 'income' : tx.type === 'expense' ? 'expense' : null;
  const date = String(tx.date || '');
  const amount = Number(tx.amount);
  if (!type || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amount) || amount <= 0) return null;
  return {
    type: type,
    row: Number(tx.row) || 0,
    date: date,
    amount: amount,
    category: String(tx.category || '').trim(),
    note: String(tx.note || '').trim(),
    source: String(tx.source || '').trim(),
    fp: String(tx.fp || '')
  };
}

function applyPayload(payload) {
  if (!payload) return;
  const income = Array.isArray(payload.income) ? payload.income : [];
  const expense = Array.isArray(payload.expense) ? payload.expense : [];

  state.income = income.map(normaliseTransaction).filter(Boolean);
  state.expense = expense.map(normaliseTransaction).filter(Boolean);

  const cats = payload.cats || {};
  state.cats = {
    income: Array.isArray(cats.income) ? cats.income.map(String) : [],
    expense: Array.isArray(cats.expense) ? cats.expense.map(String) : []
  };

  state.wallets = (Array.isArray(payload.wallets) ? payload.wallets : []).map(normaliseWallet).filter(Boolean);

  const has = payload.has || {};
  const incomeHas = has.income || {};
  const expenseHas = has.expense || {};
  const categoryAvailable = incomeHas.category !== false && expenseHas.category !== false;
  const noteAvailable = incomeHas.note !== false && expenseHas.note !== false;
  const sourceAvailable = incomeHas.source !== false && expenseHas.source !== false && state.wallets.length > 0;
  state.has = { category: categoryAvailable, note: noteAvailable, source: sourceAvailable };

  if (payload.today && /^\d{4}-\d{2}-\d{2}$/.test(payload.today)) {
    state.today = payload.today;
  }

  document.body.classList.toggle('has-no-category', !state.has.category);
  document.body.classList.toggle('has-no-note', !state.has.note);
  document.body.classList.toggle('has-no-source', !state.has.source);

  if (!$('inputTanggal').value) $('inputTanggal').value = state.today;
  if (!$('rangeStart').value) $('rangeStart').value = state.today.slice(0, 8) + '01';
  if (!$('rangeEnd').value) $('rangeEnd').value = state.today;
}

function saveSnapshot(data) {
  try {
    localStorage.setItem(STORAGE_SNAPSHOT, JSON.stringify({ at: Date.now(), data: data }));
  } catch (err) {
    /* penyimpanan penuh atau diblokir — abaikan */
  }
}

function readSnapshot() {
  try {
    const raw = localStorage.getItem(STORAGE_SNAPSHOT);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.data) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_PREFS);
    if (!raw) return;
    const prefs = JSON.parse(raw);
    if (prefs && (prefs.period === 'hari' || prefs.period === 'minggu' || prefs.period === 'bulan' || prefs.period === 'custom')) {
      state.period = prefs.period;
    }
    if (prefs && prefs.range && typeof prefs.range === 'object') {
      state.range.start = String(prefs.range.start || '');
      state.range.end = String(prefs.range.end || '');
    }
    state.hideAmounts = Boolean(prefs && prefs.hideAmounts);
  } catch (err) {
    /* prefs rusak — pakai default */
  }
}

function savePrefs() {
  try {
    localStorage.setItem(STORAGE_PREFS, JSON.stringify({
      period: state.period,
      range: state.range,
      hideAmounts: state.hideAmounts
    }));
  } catch (err) {
    /* abaikan */
  }
}

function applyPrefs() {
  state.today = localISO(new Date());
  state.range.start = state.range.start || state.today.slice(0, 8) + '01';
  state.range.end = state.range.end || state.today;

  $('rangeStart').value = state.range.start;
  $('rangeEnd').value = state.range.end;
  $('rangeCard').hidden = state.period !== 'custom';
  $('inputTanggal').value = state.today;
  $('eyeIcon').textContent = state.hideAmounts ? '🙈' : '👁️';
  $('btnHide').setAttribute('aria-pressed', String(state.hideAmounts));

  document.querySelectorAll('[data-period]').forEach((btn) => {
    const active = btn.dataset.period === state.period;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

/* =========================================================
   Periode
   ========================================================= */
function currentRange() {
  const today = state.today;

  if (state.period === 'hari') {
    return { start: today, end: today };
  }
  if (state.period === 'minggu') {
    return { start: addDaysISO(today, -6), end: today };
  }
  if (state.period === 'custom') {
    const start = state.range.start || today.slice(0, 8) + '01';
    const end = state.range.end || today;
    return start <= end ? { start: start, end: end } : { start: end, end: start };
  }
  return { start: today.slice(0, 8) + '01', end: today };
}

function periodLabelText(range) {
  if (state.period === 'hari') return 'hari ini';
  if (state.period === 'minggu') return '7 hari terakhir';
  if (state.period === 'bulan') return formatMonthLong(range.start);
  if (range.start.slice(0, 7) === range.end.slice(0, 7)) {
    return Number(range.start.slice(8, 10)) + '–' + formatDateShort(range.end);
  }
  return formatDateShort(range.start) + ' – ' + formatDateShort(range.end);
}

function inRange(tx, range) {
  return tx.date >= range.start && tx.date <= range.end;
}

function filteredIncome() {
  const range = currentRange();
  return state.income.filter((tx) => inRange(tx, range));
}

function filteredExpense() {
  const range = currentRange();
  return state.expense.filter((tx) => inRange(tx, range));
}

/* =========================================================
   Render utama
   ========================================================= */
function renderAll() {
  renderStatus();
  renderBalance();
  renderWallets();
  renderCharts();
  renderInsights();
  renderFilters();
  renderHistory();
  renderCategoryPage();
}

function renderStatus() {
  const banner = $('offlineBanner');
  const offline = state.offline || navigator.onLine === false;
  banner.hidden = !offline;
  if (offline) {
    const when = state.lastSync ? new Date(state.lastSync).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'belum pernah';
    $('offlineText').textContent = state.offline
      ? 'Mode offline — data per ' + when + '. Perubahan tidak bisa disimpan.'
      : 'Tidak ada koneksi internet. Menampilkan data terakhir (' + when + ').';
  }

  const errorCard = $('errorCard');
  const showError = Boolean(state.error) && !state.hasData;
  errorCard.hidden = !showError;
  if (showError) $('errorMessage').textContent = state.error;

  $('syncStatus').textContent = state.lastSync
    ? 'Terakhir: ' + new Date(state.lastSync).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'Belum disinkronkan';
}

function renderBalance() {
  const range = currentRange();
  const income = filteredIncome();
  const expense = filteredExpense();
  const totalIncome = sum(income);
  const totalExpense = sum(expense);
  const net = totalIncome - totalExpense;
  const allTimeNet = sum(state.income) - sum(state.expense);

  $('periodLabel').textContent = periodLabelText(range);
  $('netAmount').textContent = state.hideAmounts ? '••••••' : formatRupiah(net);
  $('sumIncome').textContent = state.hideAmounts ? '••••••' : formatRupiah(totalIncome);
  $('sumExpense').textContent = state.hideAmounts ? '••••••' : formatRupiah(totalExpense);

  const footLabel = state.has.source ? 'Saldo total kantong: ' : 'Saldo total semua data: ';
  const footValue = state.has.source ? walletTotal() : allTimeNet;
  $('totalFoot').textContent = footLabel + (state.hideAmounts ? '••••••' : formatRupiah(footValue));
}

function renderWallets() {
  const host = $('kantongList');
  const hint = $('kantongHint');

  if (!state.has.source) {
    host.innerHTML = '';
    hint.textContent = '';
    return;
  }

  const wallets = activeWallets();
  hint.textContent = state.hideAmounts ? '••••••' : formatRupiah(walletTotal());

  if (!wallets.length) {
    host.innerHTML = emptyState('💼', 'Belum ada kantong', 'Tambahkan baris di sheet SumberDana (kolom Nama) lalu muat ulang.');
    return;
  }

  host.innerHTML = wallets.map((wallet) => {
    const saldo = Number(wallet.saldo) || 0;
    return '<div class="wallet-item">' +
      '<span class="wallet-icon" aria-hidden="true">' + escapeHtml(wallet.icon || '💰') + '</span>' +
      '<span class="wallet-info">' +
        '<span class="wallet-name">' + escapeHtml(wallet.nama) + '</span>' +
        '<span class="wallet-type">' + escapeHtml(wallet.tipe || 'Lainnya') + '</span>' +
      '</span>' +
      '<span class="wallet-saldo ' + (saldo < 0 ? 'is-negative' : '') + '">' +
        (state.hideAmounts ? '••••••' : escapeHtml(formatRupiah(saldo))) +
      '</span>' +
    '</div>';
  }).join('');
}

/* =========================================================
   Grafik kategori
   ========================================================= */
function renderCharts() {
  renderCategoryChart();
  renderTrendChart();
}

function renderCategoryChart() {
  const host = $('catChart');
  const hint = $('catHint');

  if (!state.has.category) {
    host.innerHTML = '';
    hint.textContent = '';
    return;
  }

  const expense = filteredExpense();
  const totals = new Map();
  expense.forEach((tx) => {
    const name = tx.category || 'Tanpa kategori';
    totals.set(name, (totals.get(name) || 0) + tx.amount);
  });

  const total = sum(Array.from(totals.values()));
  hint.textContent = total > 0 ? formatRupiah(total) : '';

  if (!totals.size) {
    host.innerHTML = emptyState('📊', 'Belum ada pengeluaran', 'Transaksi pengeluaran pada periode ini akan muncul di sini.');
    return;
  }

  const sorted = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 6);
  const restTotal = sum(sorted.slice(6).map((entry) => entry[1]));
  const rows = restTotal > 0 ? top.concat([['Kategori lain', restTotal]]) : top;
  const max = rows[0][1] || 1;

  host.innerHTML = rows.map((entry) => {
    const name = entry[0];
    const value = entry[1];
    const style = catStyle(name, 'expense');
    const width = Math.max(3, Math.round((value / max) * 100));
    return (
      '<div class="bar-row">' +
        '<div class="bar-top">' +
          '<span class="bar-name">' +
            '<i class="dot is-cat" style="--c:' + style.color + '"></i>' +
            '<span>' + escapeHtml(name) + '</span>' +
          '</span>' +
          '<span class="bar-amount">' + formatRupiah(value) + '</span>' +
        '</div>' +
        '<div class="bar-track"><span class="bar-fill" style="width:' + width + '%;--c:' + style.color + '"></span></div>' +
      '</div>'
    );
  }).join('');
}

/* =========================================================
   Grafik tren (SVG, tanpa library)
   ========================================================= */
function buildBuckets(range) {
  const days = diffDays(range.start, range.end) + 1;
  const daily = days <= 45;
  const map = new Map();
  const order = [];

  if (daily) {
    for (let i = 0; i < days; i++) {
      const key = addDaysISO(range.start, i);
      map.set(key, { label: String(Number(key.slice(8, 10))), income: 0, expense: 0 });
      order.push(key);
    }
  } else {
    let cursor = fromISO(range.start);
    cursor.setDate(1);
    const endDate = fromISO(range.end);
    let guard = 0;
    while (cursor <= endDate && guard < 240) {
      const key = cursor.getFullYear() + '-' + pad2(cursor.getMonth() + 1);
      map.set(key, {
        label: cursor.toLocaleDateString('id-ID', { month: 'short' }),
        income: 0,
        expense: 0
      });
      order.push(key);
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1, 12);
      guard++;
    }
  }

  const assign = (tx, field) => {
    const key = daily ? tx.date : tx.date.slice(0, 7);
    const bucket = map.get(key);
    if (bucket) bucket[field] += tx.amount;
  };

  state.income.filter((tx) => inRange(tx, range)).forEach((tx) => assign(tx, 'income'));
  state.expense.filter((tx) => inRange(tx, range)).forEach((tx) => assign(tx, 'expense'));

  return { buckets: order.map((key) => map.get(key)), daily: daily };
}

function renderTrendChart() {
  const host = $('trendChart');
  const hint = $('trendHint');
  const range = currentRange();
  const built = buildBuckets(range);
  const buckets = built.buckets;

  hint.textContent = built.daily ? 'harian' : 'bulanan';

  const hasValues = buckets.some((bucket) => bucket.income > 0 || bucket.expense > 0);
  if (!hasValues) {
    host.dataset.sig = '';
    host.innerHTML = '<p class="trend-empty">Belum ada transaksi pada periode ini.</p>';
    return;
  }

  const width = Math.max(240, Math.round(host.clientWidth || host.getBoundingClientRect().width || 300));
  const signature = width + '|' + buckets.map((b) => b.label + ':' + b.income + ':' + b.expense).join(',');
  if (host.dataset.sig === signature) return;
  host.dataset.sig = signature;
  host.innerHTML = trendMarkup(buckets, width);
}

function trendMarkup(buckets, width) {
  const height = 168;
  const padTop = 8;
  const padBottom = 22;
  const plotHeight = height - padTop - padBottom;
  const base = padTop + plotHeight;
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.income, b.expense)));
  const slot = width / buckets.length;
  const gap = slot > 24 ? 3 : 1.5;
  const barWidth = Math.max(1.5, Math.min(11, (slot - gap * 2) / 2));
  const radius = Math.min(2.5, barWidth / 2);

  const grid = [0, 0.5, 1].map((fraction) => {
    const y = (base - plotHeight * fraction).toFixed(1);
    const dash = fraction === 0 ? '' : ' stroke-dasharray="3 4"';
    return '<line x1="0" y1="' + y + '" x2="' + width + '" y2="' + y + '" stroke="rgba(59,38,22,0.10)" stroke-width="1"' + dash + '/>';
  }).join('');

  const labelStep = Math.max(1, Math.ceil(26 / slot));
  const labelIndices = [];
  for (let i = 0; i < buckets.length; i += labelStep) labelIndices.push(i);
  const lastIndex = buckets.length - 1;
  if (labelIndices[labelIndices.length - 1] !== lastIndex) {
    const gapToLast = (lastIndex - labelIndices[labelIndices.length - 1]) * slot;
    if (gapToLast < 24) labelIndices[labelIndices.length - 1] = lastIndex;
    else labelIndices.push(lastIndex);
  }

  const bars = buckets.map((bucket, index) => {
    const center = index * slot + slot / 2;
    const xIncome = center - barWidth - gap / 2;
    const xExpense = center + gap / 2;
    const hIncome = (bucket.income / max) * plotHeight;
    const hExpense = (bucket.expense / max) * plotHeight;

    let markup = '';
    if (hIncome > 0) {
      markup += '<rect x="' + xIncome.toFixed(1) + '" y="' + (base - hIncome).toFixed(1) +
        '" width="' + barWidth.toFixed(1) + '" height="' + Math.max(1.6, hIncome).toFixed(1) +
        '" rx="' + radius + '" fill="url(#gradIncome)"><title>Masuk ' + escapeHtml(bucket.label) + ': ' +
        escapeHtml(formatRupiah(bucket.income)) + '</title></rect>';
    }
    if (hExpense > 0) {
      markup += '<rect x="' + xExpense.toFixed(1) + '" y="' + (base - hExpense).toFixed(1) +
        '" width="' + barWidth.toFixed(1) + '" height="' + Math.max(1.6, hExpense).toFixed(1) +
        '" rx="' + radius + '" fill="url(#gradExpense)"><title>Keluar ' + escapeHtml(bucket.label) + ': ' +
        escapeHtml(formatRupiah(bucket.expense)) + '</title></rect>';
    }
    if (labelIndices.indexOf(index) !== -1) {
      const labelX = Math.min(width - 12, Math.max(12, center));
      markup += '<text class="trend-label" x="' + labelX.toFixed(1) + '" y="' + (height - 6) + '" text-anchor="middle">' +
        escapeHtml(bucket.label) + '</text>';
    }
    return markup;
  }).join('');

  return '<svg viewBox="0 0 ' + width + ' ' + height + '" width="' + width + '" height="' + height +
    '" role="img" aria-label="Grafik pemasukan dan pengeluaran per periode">' +
    '<defs>' +
      '<linearGradient id="gradIncome" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="#1aa17a"/><stop offset="100%" stop-color="#0f7a5f"/>' +
      '</linearGradient>' +
      '<linearGradient id="gradExpense" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="#c95d46"/><stop offset="100%" stop-color="#b23f2c"/>' +
      '</linearGradient>' +
    '</defs>' + grid + bars + '</svg>';
}

/* =========================================================
   Insight
   ========================================================= */
function renderInsights() {
  const host = $('insightList');
  const range = currentRange();
  const income = filteredIncome();
  const expense = filteredExpense();
  const totalIncome = sum(income);
  const totalExpense = sum(expense);
  const days = Math.max(1, diffDays(range.start, range.end) + 1);

  if (!income.length && !expense.length) {
    host.innerHTML = emptyState('💡', 'Belum ada transaksi', 'Insight akan muncul setelah ada data pada periode ini.');
    return;
  }

  const items = [];

  if (state.has.category && totalExpense > 0) {
    const totals = new Map();
    expense.forEach((tx) => {
      const name = tx.category || 'Tanpa kategori';
      totals.set(name, (totals.get(name) || 0) + tx.amount);
    });
    const top = Array.from(totals.entries()).sort((a, b) => b[1] - a[1])[0];
    if (top) {
      const share = Math.round((top[1] / totalExpense) * 100);
      items.push({
        icon: catStyle(top[0], 'expense').icon,
        html: 'Terbesar: <strong>' + escapeHtml(top[0]) + '</strong> — ' + formatRupiah(top[1]) + ' (' + share + '% dari pengeluaran)'
      });
    }
  }

  if (totalExpense > 0) {
    items.push({
      icon: '📊',
      html: 'Rata-rata pengeluaran <strong>' + formatRupiah(totalExpense / days) + '/hari</strong> selama ' + days + ' hari'
    });
  }

  const span = days;
  const prevRange = { start: addDaysISO(range.start, -span), end: addDaysISO(range.start, -1) };
  const prevExpense = sum(state.expense.filter((tx) => inRange(tx, prevRange)));
  if (prevExpense > 0) {
    const delta = ((totalExpense - prevExpense) / prevExpense) * 100;
    const rounded = Math.round(Math.abs(delta));
    if (rounded < 1) {
      items.push({ icon: '➖', html: 'Pengeluaran <strong>sama</strong> dengan periode sebelumnya (' + formatRupiah(prevExpense) + ')' });
    } else if (delta > 0) {
      items.push({ icon: '📈', html: 'Pengeluaran <strong>naik ' + rounded + '%</strong> dibanding periode sebelumnya (' + formatRupiah(prevExpense) + ')' });
    } else {
      items.push({ icon: '📉', html: 'Pengeluaran <strong>turun ' + rounded + '%</strong> dibanding periode sebelumnya (' + formatRupiah(prevExpense) + ')' });
    }
  }

  const net = totalIncome - totalExpense;
  items.push({
    icon: net >= 0 ? '💚' : '💔',
    html: net >= 0
      ? 'Surplus <strong>' + formatRupiah(net) + '</strong> pada periode ini'
      : 'Defisit <strong>' + formatRupiah(Math.abs(net)) + '</strong> — pengeluaran melebihi pemasukan'
  });

  items.push({
    icon: '📝',
    html: '<strong>' + (income.length + expense.length) + ' transaksi</strong> tercatat (' + income.length + ' masuk, ' + expense.length + ' keluar)'
  });

  host.innerHTML = items.map((item) => (
    '<div class="insight-item">' +
      '<span class="insight-icon" aria-hidden="true">' + item.icon + '</span>' +
      '<span class="insight-text">' + item.html + '</span>' +
    '</div>'
  )).join('');
}

/* =========================================================
   Riwayat
   ========================================================= */
function renderFilters() {
  const select = $('filterCat');
  const categories = Array.from(new Set(state.cats.income.concat(state.cats.expense))).sort((a, b) => a.localeCompare(b, 'id'));
  const signature = categories.join('|');

  if (select.dataset.sig !== signature) {
    select.innerHTML = '<option value="semua">Semua kategori</option>' +
      categories.map((name) => '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>').join('');
    select.dataset.sig = signature;
  }

  const stillExists = state.filters.cat === 'semua' || categories.indexOf(state.filters.cat) !== -1;
  if (!stillExists) state.filters.cat = 'semua';
  select.value = state.filters.cat;
  $('filterType').value = state.filters.type;

  const walletSelect = $('filterWallet');
  const wallets = activeWallets();
  const walletSignature = wallets.map((wallet) => wallet.nama).join('|');

  if (walletSelect.dataset.sig !== walletSignature) {
    walletSelect.innerHTML = '<option value="semua">Semua kantong</option>' +
      wallets.map((wallet) => '<option value="' + escapeHtml(wallet.nama) + '">' +
        escapeHtml((wallet.icon ? wallet.icon + ' ' : '') + wallet.nama) + '</option>').join('');
    walletSelect.dataset.sig = walletSignature;
  }

  const walletExists = state.filters.wallet === 'semua' ||
    wallets.some((wallet) => wallet.nama === state.filters.wallet);
  if (!walletExists) state.filters.wallet = 'semua';
  walletSelect.value = state.filters.wallet;
}

function matchesFilters(tx) {
  const filters = state.filters;
  if (filters.type !== 'semua' && tx.type !== filters.type) return false;
  if (filters.cat !== 'semua' && tx.category !== filters.cat) return false;
  if (filters.wallet !== 'semua' && tx.source !== filters.wallet) return false;

  const query = filters.q.trim().toLowerCase();
  if (!query) return true;

  const haystack = [
    tx.category,
    tx.note,
    tx.source,
    tx.date,
    formatDateShort(tx.date),
    String(tx.amount),
    formatNumber(tx.amount)
  ].join(' ').toLowerCase();

  return haystack.indexOf(query) !== -1;
}

function renderHistory() {
  const host = $('historyList');
  const all = state.income.concat(state.expense).slice();

  const matched = all.filter(matchesFilters);
  matched.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return b.row - a.row;
  });

  state.view = matched;

  if (!matched.length) {
    const hasAny = all.length > 0;
    host.innerHTML = emptyState(
      '📭',
      hasAny ? 'Tidak ada yang cocok' : 'Belum ada transaksi',
      hasAny ? 'Coba ubah kata kunci atau filter.' : 'Tekan tombol + untuk mencatat transaksi pertama.'
    );
    return;
  }

  const visible = matched.slice(0, state.limit);
  const groups = new Map();
  visible.forEach((tx, index) => {
    if (!groups.has(tx.date)) groups.set(tx.date, []);
    groups.get(tx.date).push({ tx: tx, index: index });
  });

  let html = '';
  groups.forEach((entries, date) => {
    html += '<div class="history-group">';
    html += '<p class="history-date">' + escapeHtml(dayLabel(date)) + '</p>';
    entries.forEach((entry) => {
      html += historyItemMarkup(entry.tx, entry.index);
    });
    html += '</div>';
  });

  if (matched.length > visible.length) {
    html += '<button class="more-btn" type="button" data-action="more">Muat ' +
      Math.min(PAGE_SIZE, matched.length - visible.length) + ' transaksi lagi</button>';
  }

  host.innerHTML = html;
}

function dayLabel(iso) {
  const today = state.today;
  if (iso === today) return 'Hari ini · ' + formatDateShort(iso);
  if (iso === addDaysISO(today, -1)) return 'Kemarin · ' + formatDateShort(iso);
  return formatDateLong(iso);
}

function historyItemMarkup(tx, index) {
  const style = catStyle(tx.category, tx.type);
  const isIncome = tx.type === 'income';
  const title = tx.category || (isIncome ? 'Pemasukan' : 'Pengeluaran');
  const walletText = tx.source ? (isIncome ? 'ke ' + tx.source : 'dari ' + tx.source) : '';
  const detail = [tx.note, walletText].filter(Boolean).join(' · ') || 'Tanpa catatan';
  return (
    '<button class="history-item" type="button" data-idx="' + index + '">' +
      '<span class="history-icon ' + (isIncome ? 'is-income' : '') + '" aria-hidden="true">' + style.icon + '</span>' +
      '<span class="history-main">' +
        '<span class="history-title">' + escapeHtml(title) + '</span>' +
        '<span class="history-sub">' + escapeHtml(detail) + '</span>' +
      '</span>' +
      '<span class="history-amount ' + (isIncome ? 'is-income' : '') + '">' +
        (isIncome ? '+' : '−') + escapeHtml(formatRupiah(tx.amount)) +
      '</span>' +
    '</button>'
  );
}

function emptyState(icon, title, text) {
  return '<div class="empty-state">' +
    '<span class="empty-state-icon" aria-hidden="true">' + icon + '</span>' +
    '<span class="empty-state-title">' + escapeHtml(title) + '</span>' +
    '<span>' + escapeHtml(text) + '</span>' +
  '</div>';
}

/* =========================================================
   Halaman kategori
   ========================================================= */
function renderCategoryPage() {
  if (!state.has.category) {
    $('catMissing').hidden = false;
    return;
  }
  $('catMissing').hidden = true;

  $('catIncomeList').innerHTML = state.cats.income.length
    ? state.cats.income.map((name) => categoryChipMarkup(name, 'income')).join('')
    : emptyState('🏷️', 'Belum ada kategori', 'Tambahkan kolom Kategori pada sheet Pemasukan.');

  $('catExpenseList').innerHTML = state.cats.expense.length
    ? state.cats.expense.map((name) => categoryChipMarkup(name, 'expense')).join('')
    : emptyState('🏷️', 'Belum ada kategori', 'Tambahkan kolom Kategori pada sheet Pengeluaran.');
}

function categoryChipMarkup(name, type) {
  const style = catStyle(name, type);
  return '<span class="chip" style="--c:' + style.color + '">' +
    '<span aria-hidden="true">' + style.icon + '</span>' +
    '<span>' + escapeHtml(name) + '</span>' +
  '</span>';
}

/* =========================================================
   Navigasi
   ========================================================= */
function switchPage(page) {
  const target = $('page-' + page);
  if (!target) return;

  document.querySelectorAll('.page').forEach((section) => {
    section.classList.toggle('is-active', section === target);
  });

  document.querySelectorAll('.nav-item').forEach((btn) => {
    const active = btn.dataset.page === page;
    btn.classList.toggle('is-active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });

  if (page === 'dashboard') {
    renderBalance();
    renderWallets();
    renderCharts();
    renderInsights();
  }
  if (page === 'riwayat') renderHistory();
  if (page === 'kategori') renderCategoryPage();

  window.scrollTo({ top: 0, behavior: 'auto' });
}

function setPeriod(period) {
  state.period = period;
  if (period === 'custom') {
    if (!state.range.start) state.range.start = state.today.slice(0, 8) + '01';
    if (!state.range.end) state.range.end = state.today;
    $('rangeStart').value = state.range.start;
    $('rangeEnd').value = state.range.end;
  }
  $('rangeCard').hidden = period !== 'custom';
  document.querySelectorAll('[data-period]').forEach((btn) => {
    const active = btn.dataset.period === period;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  savePrefs();
  renderBalance();
  renderCharts();
  renderInsights();
}

function applyCustomRange() {
  let start = $('rangeStart').value;
  let end = $('rangeEnd').value;

  if (!start || !end) {
    showToast('Isi tanggal awal dan akhir', 'error');
    return;
  }
  if (start > end) {
    const swap = start;
    start = end;
    end = swap;
    $('rangeStart').value = start;
    $('rangeEnd').value = end;
  }

  state.range.start = start;
  state.range.end = end;
  savePrefs();
  renderBalance();
  renderCharts();
  renderInsights();
}

/* =========================================================
   Modal
   ========================================================= */
function openSheet(id) {
  if (state.confirmResolve && id !== 'dialogConfirm') {
    const resolve = state.confirmResolve;
    state.confirmResolve = null;
    resolve(false);
  }

  const overlay = $('overlay');
  overlay.hidden = false;
  Array.prototype.forEach.call(overlay.children, (child) => {
    child.hidden = child.id !== id;
  });
  document.body.classList.add('is-locked');

  const sheet = $(id);
  if (!sheet) return;
  sheet.scrollTop = 0;

  const focusTarget = sheet.querySelector('input:not([type="hidden"]), select, button');
  if (focusTarget) {
    setTimeout(() => {
      try {
        focusTarget.focus({ preventScroll: true });
      } catch (err) {
        focusTarget.focus();
      }
    }, 70);
  }
}

function closeOverlay() {
  if (state.confirmResolve) {
    const resolve = state.confirmResolve;
    state.confirmResolve = null;
    resolve(false);
  }
  $('overlay').hidden = true;
  document.body.classList.remove('is-locked');
}

function askConfirm(options) {
  $('confirmTitle').textContent = options.title || 'Lanjutkan?';
  $('confirmMessage').textContent = options.message || '';
  $('btnConfirm').textContent = options.confirmLabel || 'Hapus';
  openSheet('dialogConfirm');

  return new Promise((resolve) => {
    state.confirmResolve = resolve;
  });
}

function resolveConfirm(value) {
  const resolve = state.confirmResolve;
  state.confirmResolve = null;
  closeOverlay();
  if (resolve) resolve(value);
}

/* =========================================================
   Form transaksi
   ========================================================= */
function setFormType(type) {
  state.form.type = type === 'income' ? 'income' : 'expense';
  state.form.category = '';

  document.querySelectorAll('.segment-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.type === state.form.type);
  });

  const list = state.cats[state.form.type];
  if (list.length) {
    state.form.category = mostUsedCategory(state.form.type) || list[0];
  }
  if (!state.form.wallet) {
    state.form.wallet = mostUsedWallet(state.form.type) || (activeWallets()[0] || {}).nama || '';
  }
  renderCategoryChips();
  renderWalletChips();
  updateWalletFormMeta();
}

function mostUsedCategory(type) {
  const source = type === 'income' ? state.income : state.expense;
  const totals = new Map();
  source.forEach((tx) => {
    if (!tx.category) return;
    totals.set(tx.category, (totals.get(tx.category) || 0) + 1);
  });
  if (!totals.size) return null;
  return Array.from(totals.entries()).sort((a, b) => b[1] - a[1])[0][0];
}

function renderCategoryChips() {
  const host = $('kategoriChips');
  const list = state.cats[state.form.type] || [];

  if (!list.length) {
    host.innerHTML = '<p class="hint-text">Belum ada kategori untuk jenis ini.</p>';
    return;
  }

  host.innerHTML = list.map((name) => {
    const style = catStyle(name, state.form.type);
    const selected = state.form.category === name;
    return '<button class="chip ' + (selected ? 'is-selected' : '') + '" type="button" data-cat="' + escapeHtml(name) + '">' +
      '<span aria-hidden="true">' + style.icon + '</span>' +
      '<span>' + escapeHtml(name) + '</span>' +
    '</button>';
  }).join('');
}

function renderWalletChips() {
  const host = $('kantongChips');
  if (!state.has.source) {
    host.innerHTML = '';
    return;
  }

  const wallets = activeWallets();
  if (!wallets.length) {
    host.innerHTML = '<p class="hint-text">Belum ada kantong dana di sheet SumberDana.</p>';
    return;
  }

  host.innerHTML = wallets.map((wallet) => {
    const selected = state.form.wallet === wallet.nama;
    return '<button class="chip chip--wallet ' + (selected ? 'is-selected' : '') + '" type="button" data-wallet="' + escapeHtml(wallet.nama) + '">' +
      '<span aria-hidden="true">' + escapeHtml(wallet.icon || '💰') + '</span>' +
      '<span class="chip-text">' +
        '<span class="chip-name">' + escapeHtml(wallet.nama) + '</span>' +
        '<span class="chip-sub">' + escapeHtml(formatRupiah(wallet.saldo)) + '</span>' +
      '</span>' +
    '</button>';
  }).join('');
}

// Label & saldo kantong yang sedang dipilih, mengikuti jenis transaksi.
function updateWalletFormMeta() {
  if (!state.has.source) return;

  const isIncome = state.form.type === 'income';
  const label = $('kantongLabel');
  const info = $('kantongInfo');
  if (!label || !info) return;

  label.textContent = isIncome ? 'Uang masuk ke kantong' : 'Diambil dari kantong';

  const wallet = activeWallets().find((item) => item.nama === state.form.wallet);
  if (!wallet) {
    info.textContent = 'Pilih kantong ' + (isIncome ? 'tujuan' : 'sumber') + ' untuk transaksi ini.';
    info.classList.remove('is-warning');
    return;
  }

  const saldo = Number(wallet.saldo) || 0;
  const amount = Number(String($('inputNominal').value).replace(/\D/g, '')) || 0;
  let text = 'Saldo ' + wallet.nama + ': ' + formatRupiah(saldo);

  if (!isIncome && amount > 0 && amount > saldo) {
    text += ' • melebihi saldo (kurang ' + formatRupiah(amount - saldo) + ')';
    info.classList.add('is-warning');
  } else {
    info.classList.remove('is-warning');
  }
  info.textContent = text;
}

function openTransactionForm(tx) {
  state.form.editing = tx || null;
  state.form.busy = false;

  $('sheetTransaksiTitle').textContent = tx ? 'Edit transaksi' : 'Tambah transaksi';

  const type = tx ? tx.type : 'expense';
  state.form.type = type;
  document.querySelectorAll('.segment-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.type === type);
  });

  $('inputNominal').value = tx ? formatNumber(tx.amount) : '';
  $('inputTanggal').value = tx ? tx.date : (state.today || localISO(new Date()));
  $('inputCatatan').value = tx ? tx.note : '';
  $('formError').hidden = true;

  state.form.category = tx ? tx.category : (mostUsedCategory(type) || (state.cats[type] || [])[0] || '');
  state.form.wallet = tx
    ? String(tx.source || '')
    : (mostUsedWallet(type) || (activeWallets()[0] || {}).nama || '');
  renderCategoryChips();
  renderWalletChips();
  updateWalletFormMeta();

  $('btnSubmit').disabled = false;
  $('btnSubmit').textContent = tx ? 'Simpan perubahan' : 'Simpan transaksi';

  openSheet('sheetTransaksi');
}

function showFormError(message) {
  const box = $('formError');
  box.textContent = message;
  box.hidden = false;
}

async function submitTransaction(event) {
  event.preventDefault();
  if (state.form.busy) return;

  const amount = Number(String($('inputNominal').value).replace(/\D/g, '')) || 0;
  const date = $('inputTanggal').value;
  const note = $('inputCatatan').value.trim();
  const category = state.has.category ? state.form.category : '';
  const wallet = state.has.source ? state.form.wallet : '';

  if (amount <= 0) {
    showFormError('Nominal harus lebih dari 0.');
    $('inputNominal').focus();
    return;
  }
  if (!date) {
    showFormError('Tanggal wajib diisi.');
    $('inputTanggal').focus();
    return;
  }
  if (state.has.category && !category) {
    showFormError('Pilih kategori terlebih dahulu.');
    return;
  }
  if (state.has.source && !wallet) {
    showFormError('Pilih kantong dana terlebih dahulu.');
    return;
  }

  const editing = state.form.editing;
  const button = $('btnSubmit');
  state.form.busy = true;
  button.disabled = true;
  button.textContent = 'Menyimpan…';

  try {
    if (editing) {
      await api('update', {
        type: editing.type,
        row: editing.row,
        fp: editing.fp,
        date: date,
        amount: amount,
        category: category,
        note: note,
        source: wallet
      });
    } else {
      await api('add', {
        type: state.form.type,
        date: date,
        amount: amount,
        category: category,
        note: note,
        source: wallet
      });
    }

    closeOverlay();
    showToast(editing ? 'Transaksi diperbarui' : 'Transaksi tersimpan', 'success');
    state.form.editing = null;
    await loadData({ silent: true });
  } catch (err) {
    showFormError((err && err.message) || 'Gagal menyimpan transaksi.');
  } finally {
    state.form.busy = false;
    button.disabled = false;
    button.textContent = editing ? 'Simpan perubahan' : 'Simpan transaksi';
  }
}

function openActionSheet(tx) {
  if (!tx) return;
  state.action = tx;
  const style = catStyle(tx.category, tx.type);
  $('aksiTitle').textContent = (tx.category || (tx.type === 'income' ? 'Pemasukan' : 'Pengeluaran'));
  $('aksiMeta').textContent = style.icon + '  ' + formatDateShort(tx.date) + ' • ' +
    (tx.type === 'income' ? '+' : '−') + formatRupiah(tx.amount) +
    (tx.source ? ' • ' + (tx.type === 'income' ? 'ke ' : 'dari ') + tx.source : '') +
    (tx.note ? ' • ' + tx.note : '');
  openSheet('sheetAksi');
}

async function deleteAction() {
  const tx = state.action;
  if (!tx) return;

  const confirmed = await askConfirm({
    title: 'Hapus transaksi?',
    message: (tx.category || 'Transaksi') + ' sebesar ' + formatRupiah(tx.amount) + ' pada ' +
      formatDateShort(tx.date) + ' akan dihapus dari spreadsheet. Tindakan ini tidak bisa dibatalkan.',
    confirmLabel: 'Hapus'
  });
  if (!confirmed) return;

  try {
    await api('delete', { type: tx.type, row: tx.row, fp: tx.fp });
    state.action = null;
    showToast('Transaksi dihapus', 'success');
    await loadData({ silent: true });
  } catch (err) {
    showToast((err && err.message) || 'Gagal menghapus transaksi.', 'error', 4200);
  }
}

/* =========================================================
   Export
   ========================================================= */
function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n;]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function exportData() {
  const rows = state.income.concat(state.expense).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.row - a.row));
  if (!rows.length) {
    showToast('Belum ada data untuk diexport', 'error');
    return;
  }

  const header = ['Jenis', 'Tanggal', 'Nominal', 'Kategori', 'Sumber Dana', 'Catatan'];
  const lines = [header.join(',')].concat(rows.map((tx) => [
    tx.type === 'income' ? 'Pemasukan' : 'Pengeluaran',
    tx.date,
    tx.amount,
    tx.category,
    tx.source,
    tx.note
  ].map(csvCell).join(',')));

  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'keuangan-' + localISO(new Date()) + '.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  showToast('Data diexport', 'success');
}

/* =========================================================
   Toast
   ========================================================= */
let toastTimer = null;
function showToast(message, variant, duration) {
  const toast = $('toast');
  toast.textContent = message;
  toast.className = 'toast is-visible' + (variant ? ' is-' + variant : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = 'toast';
  }, duration || 2600);
}

/* =========================================================
   Events
   ========================================================= */
function bindEvents() {
  document.addEventListener('click', onDocumentClick);

  $('btnRefresh').addEventListener('click', () => loadData({ silent: true }));

  $('btnHide').addEventListener('click', () => {
    state.hideAmounts = !state.hideAmounts;
    $('eyeIcon').textContent = state.hideAmounts ? '🙈' : '👁️';
    $('btnHide').setAttribute('aria-pressed', String(state.hideAmounts));
    $('btnHide').setAttribute('aria-label', state.hideAmounts ? 'Tampilkan nominal' : 'Sembunyikan nominal');
    savePrefs();
    renderBalance();
    renderWallets();
  });

  $('btnAdd').addEventListener('click', () => openTransactionForm(null));

  $('btnApplyRange').addEventListener('click', applyCustomRange);

  $('formTransaksi').addEventListener('submit', submitTransaction);

  $('inputNominal').addEventListener('input', formatAmountField);

  $('searchInput').addEventListener('input', debounce((event) => {
    state.filters.q = event.target.value;
    state.limit = PAGE_SIZE;
    renderHistory();
  }, 120));

  $('filterType').addEventListener('change', (event) => {
    state.filters.type = event.target.value;
    state.limit = PAGE_SIZE;
    renderHistory();
  });

  $('filterCat').addEventListener('change', (event) => {
    state.filters.cat = event.target.value;
    state.limit = PAGE_SIZE;
    renderHistory();
  });

  $('filterWallet').addEventListener('change', (event) => {
    state.filters.wallet = event.target.value;
    state.limit = PAGE_SIZE;
    renderHistory();
  });

  $('btnConfirm').addEventListener('click', () => resolveConfirm(true));

  $('overlay').addEventListener('click', (event) => {
    if (event.target === $('overlay')) closeOverlay();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('overlay').hidden) {
        if (state.confirmResolve) resolveConfirm(false);
        else closeOverlay();
      }
    }
  });

  window.addEventListener('online', () => {
    renderStatus();
    loadData({ silent: true });
  });

  window.addEventListener('offline', renderStatus);
}

function onDocumentClick(event) {
  const closeTarget = event.target.closest('[data-close]');
  if (closeTarget) {
    if (state.confirmResolve) resolveConfirm(false);
    else closeOverlay();
    return;
  }

  const periodBtn = event.target.closest('[data-period]');
  if (periodBtn) {
    setPeriod(periodBtn.dataset.period);
    return;
  }

  const navBtn = event.target.closest('.nav-item');
  if (navBtn) {
    switchPage(navBtn.dataset.page);
    return;
  }

  const segmentBtn = event.target.closest('.segment-btn');
  if (segmentBtn) {
    setFormType(segmentBtn.dataset.type);
    return;
  }

  const chip = event.target.closest('[data-cat]');
  if (chip) {
    state.form.category = chip.dataset.cat;
    $('formError').hidden = true;
    renderCategoryChips();
    return;
  }

  const walletChip = event.target.closest('[data-wallet]');
  if (walletChip) {
    state.form.wallet = walletChip.dataset.wallet;
    $('formError').hidden = true;
    renderWalletChips();
    updateWalletFormMeta();
    return;
  }

  const historyItem = event.target.closest('[data-idx]');
  if (historyItem) {
    const index = Number(historyItem.dataset.idx);
    openActionSheet(state.view[index]);
    return;
  }

  const actionBtn = event.target.closest('[data-action]');
  if (actionBtn) {
    handleAction(actionBtn.dataset.action);
  }
}

function handleAction(action) {
  switch (action) {
    case 'refresh':
      loadData({ silent: true });
      break;
    case 'export':
      exportData();
      break;
    case 'about':
      openSheet('sheetTentang');
      break;
    case 'more':
      state.limit += PAGE_SIZE;
      renderHistory();
      break;
    case 'editTx':
      if (state.action) {
        const tx = state.action;
        state.action = null;
        openTransactionForm(tx);
      }
      break;
    case 'deleteTx':
      deleteAction();
      break;
    default:
      break;
  }
}

function formatAmountField(event) {
  const input = event.target;
  const caret = input.selectionStart == null ? input.value.length : input.selectionStart;
  const digitsBeforeCaret = (input.value.slice(0, caret).match(/\d/g) || []).length;
  const digits = input.value.replace(/\D/g, '').slice(0, 15);

  input.value = digits ? nfID.format(Number(digits)) : '';
  updateWalletFormMeta();

  if (!digits) {
    input.setSelectionRange(0, 0);
    return;
  }

  let position = 0;
  let counted = 0;
  for (; position < input.value.length; position++) {
    if (/\d/.test(input.value[position])) {
      counted++;
      if (counted === digitsBeforeCaret) {
        position++;
        break;
      }
    }
  }
  try {
    input.setSelectionRange(position, position);
  } catch (err) {
    /* browser lama tanpa setSelectionRange */
  }
}

/* =========================================================
   Resize observer untuk grafik
   ========================================================= */
function setupResizeObserver() {
  if (typeof ResizeObserver !== 'function') {
    window.addEventListener('resize', debounce(() => {
      $('trendChart').dataset.sig = '';
      renderTrendChart();
    }, 180));
    return;
  }

  let lastWidth = 0;
  const observer = new ResizeObserver(debounce((entries) => {
    const entry = entries[0];
    if (!entry) return;
    const width = Math.round(entry.contentRect.width);
    if (Math.abs(width - lastWidth) < 3) return;
    lastWidth = width;
    renderTrendChart();
  }, 140));

  observer.observe($('trendChart'));
}

/* =========================================================
   Service worker
   ========================================================= */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* offline cache tidak tersedia — aplikasi tetap berjalan */
    });
  });
}
