/*************** KONFIGURASI ***************/
// Opsional. Isi dengan kata sandi rahasia, lalu samakan dengan API_TOKEN di app.js.
// Bila dikosongkan, API dapat dipanggil siapa pun yang memiliki URL Web App.
const API_TOKEN = '';
// ID spreadsheet. Hanya dipakai bila project Apps Script TIDAK dibuat dari dalam
// spreadsheet (standalone). Bila project terikat, getActive() otomatis dipakai.
// Ambil dari URL: docs.google.com/spreadsheets/d/<ID_INI>/edit
const SPREADSHEET_ID = '1-y7HiiMzw8uycda8XCydbQdEy__1bOoXlUcdbFWdld8';
const SHEET_NAMES = { income: 'Pemasukan', expense: 'Pengeluaran', wallets: 'SumberDana' };
// Tulis ulang kolom SaldoSaatIni di sheet SumberDana setiap ada transaksi.
// Sel yang berisi rumus tidak akan ditimpa. Set false bila tidak diinginkan.
const SYNC_SALDO = true;
const DEFAULT_CATS = {
  expense: ['Makanan & Minuman','Transportasi','Belanja','Tagihan & Utilitas','Hiburan','Kesehatan','Pendidikan','Cicilan','Donasi & Sosial','Lainnya'],
  income: ['Gaji','Bonus','Usaha','Investasi','Hadiah','Lainnya']
};
// Kata kunci header (huruf kecil). Tambahkan jika header-mu memakai istilah lain.
const ALIASES = {
  date:     ['tanggal','tgl','date','waktu'],
  amount:   ['nominal','jumlah','nilai','amount','rp','harga'],
  source:   ['sumberdana','sumber dana','sumber','dana','kantong','dompet','wallet','akun','rekening','source','account'],
  category: ['kategori','category','sumber','jenis'],
  note:     ['catatan','keterangan','deskripsi','note','ket','uraian','memo']
};
const WALLET_ALIASES = {
  id:        ['id','kode'],
  nama:      ['nama','name','kantong','dompet','wallet'],
  tipe:      ['tipe','type','jenis'],
  saldoAwal: ['saldoawal','saldo awal','awal'],
  saldo:     ['saldosaatini','saldo saat ini','saldoakhir','saldo akhir','saldo'],
  icon:      ['icon','ikon','emoji'],
  status:    ['status'],
  catatan:   ['catatan','keterangan','note','memo']
};
const MONTHS = {jan:1,feb:2,mar:3,apr:4,mei:5,may:5,jun:6,jul:7,agu:8,aug:8,sep:9,okt:10,oct:10,nov:11,des:12,dec:12};

/*************** WEB APP ***************/
function doGet() {
  try {
    return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('Catatan Keuangan')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return json_({ ok: true, info: 'API keuangan aktif. Kirim permintaan POST.' });
  }
}

/*************** API JSON (dipanggil dari PWA) ***************/
function doPost(e) {
  try {
    const body = (e && e.postData && e.postData.contents) || '{}';
    const req = JSON.parse(body);
    if (API_TOKEN && req.token !== API_TOKEN) throw new Error('Token API tidak valid.');

    const payload = req.payload || {};
    let data;
    switch (req.action) {
      case 'bootstrap':
        data = apiBootstrap();
        break;
      case 'add':
        data = apiAdd(payload);
        break;
      case 'update':
        data = apiUpdate(payload);
        break;
      case 'delete':
        data = apiDelete(payload);
        break;
      default:
        throw new Error('Aksi "' + req.action + '" tidak dikenal.');
    }
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: (err && err.message) ? err.message : String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/*************** API (dipanggil dari HP) ***************/
function apiBootstrap() {
  const income = readRows_('income'), expense = readRows_('expense');
  const has = {};
  ['income','expense'].forEach(k => {
    const m = getTable_(k).map;
    has[k] = { category: m.category !== undefined, note: m.note !== undefined, source: m.source !== undefined };
  });
  const wallets = readWallets_();
  return {
    income, expense, has,
    cats: buildCats_(income, expense),
    wallets: wallets.list,
    today: Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd')
  };
}

function apiAdd(p) {
  const v = validate_(p);
  return withLock_(() => {
    const t = getTable_(p.type), sh = t.sh, m = t.map;
    const last = lastDataRow_(t), row = last + 1;
    const mapped = Object.keys(m).map(k => m[k]);
    const busy = mapped.some(i => row <= sh.getLastRow() && sh.getRange(row, i + 1).getValue() !== '');
    if (busy) sh.insertRowAfter(last);                       // jangan timpa baris Total dsb.
    else if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
    if (last > t.headerRow) {
      sh.getRange(last, 1, 1, t.lastCol).copyTo(sh.getRange(row, 1, 1, t.lastCol), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
      for (let c = 0; c < t.lastCol; c++) {                  // teruskan rumus di kolom lain
        if (mapped.indexOf(c) > -1) continue;
        const src = sh.getRange(last, c + 1);
        if (src.getFormula()) src.copyTo(sh.getRange(row, c + 1), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
      }
    }
    writeCells_(t, row, v);
    if (last === t.headerRow) {
      sh.getRange(row, m.date + 1).setNumberFormat('dd/mm/yyyy');
      sh.getRange(row, m.amount + 1).setNumberFormat('#,##0');
    }
    flush_();
    syncSaldo_([v.source]);
    return rowToTx_(p.type, sh.getRange(row, 1, 1, t.lastCol).getValues()[0], m, row);
  });
}

function apiUpdate(p) {
  const v = validate_(p);
  return withLock_(() => {
    const t = getTable_(p.type), row = Number(p.row);
    const before = checkRow_(t, row, p.fp);
    writeCells_(t, row, v);
    flush_();
    syncSaldo_([before.source, v.source]);
    return rowToTx_(p.type, t.sh.getRange(row, 1, 1, t.lastCol).getValues()[0], t.map, row);
  });
}

function apiDelete(p) {
  return withLock_(() => {
    const t = getTable_(p.type), row = Number(p.row);
    const before = checkRow_(t, row, p.fp);
    t.sh.deleteRow(row);
    flush_();
    syncSaldo_([before.source]);
    return { ok: true };
  });
}

/*************** HELPER ***************/
function ss_() {
  const active = SpreadsheetApp.getActive();
  if (active) return active;
  if (!SPREADSHEET_ID) {
    throw new Error('Script tidak terikat pada spreadsheet. Buat project dari spreadsheet (Extensions > Apps Script) atau isi SPREADSHEET_ID di code.gs.');
  }
  try {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (err) {
    throw new Error('Spreadsheet ' + SPREADSHEET_ID + ' tidak bisa dibuka. Pastikan akun pemilik deployment punya akses edit ke file itu. (' + err.message + ')');
  }
}
function flush_() {
  // Pada project standalone tidak ada dokumen aktif; flush tidak wajib di sana.
  try { SpreadsheetApp.flush(); } catch (err) { /* abaikan */ }
}
function tz_() { return ss_().getSpreadsheetTimeZone(); }
function pad_(n) { return ('0' + n).slice(-2); }
function withLock_(fn) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function safe_(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }   // cegah injeksi rumus

function mapHeaders_(row) {
  const heads = row.map(h => String(h).trim().toLowerCase()), map = {}, used = {};
  ['date','amount','source','category','note'].forEach(f => {
    let idx = -1;
    for (const a of ALIASES[f]) { idx = heads.findIndex((h, i) => !used[i] && h === a); if (idx > -1) break; }
    if (idx < 0) for (const a of ALIASES[f]) { idx = heads.findIndex((h, i) => !used[i] && h && h.indexOf(a) > -1); if (idx > -1) break; }
    if (idx > -1) { map[f] = idx; used[idx] = true; }
  });
  return map;
}

function mapWalletHeaders_(row) {
  const heads = row.map(h => String(h).trim().toLowerCase()), map = {}, used = {};
  ['id','nama','tipe','saldoAwal','saldo','icon','status','catatan'].forEach(f => {
    let idx = -1;
    for (const a of WALLET_ALIASES[f]) { idx = heads.findIndex((h, i) => !used[i] && h === a); if (idx > -1) break; }
    if (idx < 0) for (const a of WALLET_ALIASES[f]) { idx = heads.findIndex((h, i) => !used[i] && h && h.indexOf(a) > -1); if (idx > -1) break; }
    if (idx > -1) { map[f] = idx; used[idx] = true; }
  });
  return map;
}

function getTable_(type) {
  const name = SHEET_NAMES[type], sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" tidak ditemukan. Periksa nama sheet di spreadsheet.');
  const n = Math.min(sh.getLastRow(), 5), cols = Math.max(sh.getLastColumn(), 1);
  if (n > 0) {
    const top = sh.getRange(1, 1, n, cols).getValues();
    for (let r = 0; r < top.length; r++) {
      const m = mapHeaders_(top[r]);
      if (m.date !== undefined && m.amount !== undefined) return { sh, headerRow: r + 1, map: m, lastCol: cols };
    }
  }
  throw new Error('Header sheet "' + name + '" tidak dikenali. Pastikan ada kolom Tanggal dan Nominal/Jumlah di baris atas.');
}

function parseDate_(x) {
  if (x instanceof Date && !isNaN(x)) return Utilities.formatDate(x, tz_(), 'yyyy-MM-dd');
  const s = String(x || '').trim(); if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + pad_(m[2]) + '-' + pad_(m[3]);
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return y + '-' + pad_(m[2]) + '-' + pad_(m[1]); }
  m = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3,})[\s\-,.]*(\d{2,4})/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) { let y = +m[3]; if (y < 100) y += 2000; return y + '-' + pad_(MONTHS[m[2].slice(0, 3).toLowerCase()]) + '-' + pad_(m[1]); }
  return null;
}

function parseAmount_(x) {
  if (typeof x === 'number') return Math.abs(x);
  let s = String(x || '').replace(/rp|idr|\s/gi, '').replace(/[^0-9.,\-]/g, '');
  if (!s) return 0;
  if (s.indexOf(',') > -1 && s.indexOf('.') > -1) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.indexOf(',') > -1) s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  else if (s.indexOf('.') > -1) s = (/\.\d{1,2}$/.test(s) && s.split('.').length === 2) ? s : s.replace(/\./g, '');
  const n = parseFloat(s); return isNaN(n) ? 0 : Math.abs(n);
}

function rowToTx_(type, v, map, row) {
  const date = parseDate_(v[map.date]), amount = parseAmount_(v[map.amount]);
  if (!date || !amount) return null;                         // lewati baris kosong / Total
  const category = map.category !== undefined ? String(v[map.category]).trim() : '';
  const note = map.note !== undefined ? String(v[map.note]).trim() : '';
  const source = map.source !== undefined ? String(v[map.source]).trim() : '';
  return { type, row, date, amount, category, note, source, fp: [date, amount, category, note, source].join('|') };
}

function readRows_(type) {
  const t = getTable_(type), last = t.sh.getLastRow(), out = [];
  if (last <= t.headerRow) return out;
  t.sh.getRange(t.headerRow + 1, 1, last - t.headerRow, t.lastCol).getValues()
    .forEach((v, i) => { const tx = rowToTx_(type, v, t.map, t.headerRow + 1 + i); if (tx) out.push(tx); });
  return out;
}

function lastDataRow_(t) {
  const n = t.sh.getLastRow(); if (n <= t.headerRow) return t.headerRow;
  const d = t.sh.getRange(t.headerRow + 1, t.map.date + 1, n - t.headerRow, 1).getValues();
  for (let i = d.length - 1; i >= 0; i--) if (parseDate_(d[i][0])) return t.headerRow + 1 + i;
  return t.headerRow;
}

/*************** KANTONG DANA (sheet SumberDana) ***************/
function normalize_(s) { return String(s === null || s === undefined ? '' : s).trim().toLowerCase(); }

function getWalletTable_() {
  const name = SHEET_NAMES.wallets;
  const sh = ss_().getSheetByName(name);
  if (!sh) return null;                                      // fitur kantong nonaktif, bukan error
  const n = Math.min(sh.getLastRow(), 5), cols = Math.max(sh.getLastColumn(), 1);
  if (n > 0) {
    const top = sh.getRange(1, 1, n, cols).getValues();
    for (let r = 0; r < top.length; r++) {
      const m = mapWalletHeaders_(top[r]);
      if (m.nama !== undefined) return { sh, headerRow: r + 1, map: m, lastCol: cols };
    }
  }
  throw new Error('Header sheet "' + name + '" tidak dikenali. Pastikan ada kolom Nama di baris atas.');
}

function walletTotals_(income, expense) {
  const out = {};
  income.forEach(tx => { const k = normalize_(tx.source); if (k) out[k] = (out[k] || 0) + tx.amount; });
  expense.forEach(tx => { const k = normalize_(tx.source); if (k) out[k] = (out[k] || 0) - tx.amount; });
  return out;
}

function readWallets_() {
  const t = getWalletTable_();
  if (!t) return { list: [], map: {}, table: null };
  const last = t.sh.getLastRow();
  if (last <= t.headerRow) return { list: [], map: {}, table: t };

  const rows = t.sh.getRange(t.headerRow + 1, 1, last - t.headerRow, t.lastCol).getValues();
  const net = walletTotals_(readRows_('income'), readRows_('expense'));
  const list = [], byName = {};

  rows.forEach((v, i) => {
    const cell = (idx) => {
      if (idx === undefined || v[idx] === null || v[idx] === undefined) return '';
      return String(v[idx]).trim();
    };
    const nama = cell(t.map.nama);
    if (!nama) return;                                       // lewati baris tanpa nama
    const id = cell(t.map.id);
    const saldoAwal = t.map.saldoAwal !== undefined ? parseAmount_(v[t.map.saldoAwal]) : 0;
    // Cocokkan lewat nama (yang ditulis aplikasi) atau ID (bila diisi manual di sheet).
    const delta = net[normalize_(nama)] !== undefined
      ? net[normalize_(nama)]
      : (id ? (net[normalize_(id)] || 0) : 0);
    const wallet = {
      id: id,
      nama: nama,
      tipe: cell(t.map.tipe) || 'Lainnya',
      saldoAwal: saldoAwal,
      saldo: saldoAwal + delta,
      icon: cell(t.map.icon) || '💰',
      status: cell(t.map.status) || 'Aktif',
      catatan: cell(t.map.catatan),
      row: t.headerRow + 1 + i
    };
    list.push(wallet);
    byName[normalize_(nama)] = wallet;
  });

  return { list: list, map: byName, table: t };
}

// Menjaga kolom SaldoSaatIni tetap sesuai transaksi. Sel berisi rumus tidak diubah.
// Kegagalan di sini tidak boleh menggagalkan transaksi yang sudah tersimpan.
function syncSaldo_(names) {
  if (!SYNC_SALDO) return;
  try {
    const wanted = {};
    (names || []).forEach(n => { const k = normalize_(n); if (k) wanted[k] = 1; });
    if (!Object.keys(wanted).length) return;

    const data = readWallets_();
    const t = data.table;
    if (!t || t.map.saldo === undefined) return;

    data.list.forEach(w => {
      if (!wanted[normalize_(w.nama)]) return;
      const cell = t.sh.getRange(w.row, t.map.saldo + 1);
      if (cell.getFormula()) return;
      cell.setValue(w.saldo);
    });
    flush_();
  } catch (err) {
    Logger.log('syncSaldo_ dilewati: ' + err.message);
  }
}

function checkRow_(t, row, fp) {
  if (!(row > t.headerRow) || row > t.sh.getLastRow()) throw new Error('Baris tidak ditemukan. Muat ulang data.');
  const cur = rowToTx_('x', t.sh.getRange(row, 1, 1, t.lastCol).getValues()[0], t.map, row);
  if (!cur || cur.fp !== fp) throw new Error('Baris ini sudah berubah di spreadsheet. Muat ulang data lalu coba lagi.');
  return cur;
}

function writeCells_(t, row, v) {
  const sh = t.sh, m = t.map, d = v.date.split('-').map(Number);
  sh.getRange(row, m.date + 1).setValue(new Date(d[0], d[1] - 1, d[2], 12, 0, 0));
  sh.getRange(row, m.amount + 1).setValue(v.amount);
  if (m.category !== undefined) sh.getRange(row, m.category + 1).setValue(safe_(v.category));
  if (m.note !== undefined) sh.getRange(row, m.note + 1).setValue(safe_(v.note));
  if (m.source !== undefined) sh.getRange(row, m.source + 1).setValue(safe_(v.source));
}

function validate_(p) {
  if (!p || (p.type !== 'income' && p.type !== 'expense')) throw new Error('Jenis transaksi tidak valid.');
  const amount = Number(p.amount);
  if (!isFinite(amount) || amount <= 0) throw new Error('Nominal harus lebih dari 0.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.date))) throw new Error('Tanggal tidak valid.');
  return {
    date: p.date,
    amount: Math.round(amount * 100) / 100,
    category: String(p.category || '').trim().slice(0, 60),
    note: String(p.note || '').trim().slice(0, 200),
    source: String(p.source || '').trim().slice(0, 60)
  };
}

function buildCats_(inc, exp) {
  const mk = (def, rows) => {
    const seen = {}, out = [];
    def.concat(rows.map(r => r.category)).forEach(c => { c = String(c || '').trim(); const k = c.toLowerCase(); if (c && !seen[k]) { seen[k] = 1; out.push(c); } });
    return out;
  };
  return { income: mk(DEFAULT_CATS.income, inc), expense: mk(DEFAULT_CATS.expense, exp) };
}

/* Opsional: jalankan manual untuk melihat kolom mana yang terdeteksi (menu Lihat > Log eksekusi) */
function cekStruktur() {
  ['income','expense'].forEach(k => { const t = getTable_(k); Logger.log(SHEET_NAMES[k] + ': header di baris ' + t.headerRow + ', kolom (mulai 0) = ' + JSON.stringify(t.map)); });
  const w = getWalletTable_();
  if (!w) Logger.log('Kantong dana: sheet "' + SHEET_NAMES.wallets + '" tidak ditemukan (fitur kantong nonaktif).');
  else {
    Logger.log(SHEET_NAMES.wallets + ': header di baris ' + w.headerRow + ', kolom (mulai 0) = ' + JSON.stringify(w.map));
    const wallets = readWallets_();
    Logger.log('Kantong aktif: ' + wallets.list.map(x => x.nama + ' (' + x.saldo + ')').join(', '));
  }
}