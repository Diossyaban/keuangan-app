# Panduan Pasang & Uji — Keuangan Pribadi

Aplikasi ini terdiri dari dua bagian:

| Bagian | Berkas | Tempat |
| --- | --- | --- |
| Tampilan (PWA) | `index.html`, `styles.css`, `app.js`, `manifest.json`, `sw.js`, `icon.svg`, `icon-maskable.svg` | Hosting statis (GitHub Pages / Netlify / Cloudflare Pages) |
| Jembatan ke Sheets | `code.gs` | Google Apps Script pada spreadsheet Anda |

> **Penting:** versi `code.gs` ini menambahkan fungsi `doPost` (API JSON). Tanpa
> mendeploy ulang Apps Script, aplikasi akan menampilkan pesan
> "Server mengirim respons yang tidak dikenali".

---

## 1. Deploy ulang Apps Script (wajib)

1. Buka spreadsheet Anda → menu **Extensions → Apps Script**.

   Jika project Apps Script Anda **tidak** bisa dibuka dari menu itu (dibuat di
   `script.google.com`), buka project tersebut langsung. `code.gs` sudah memuat
   `SPREADSHEET_ID` sehingga tetap bisa membaca spreadsheet. Syaratnya akun
   pemilik deployment punya akses **edit** ke file spreadsheet itu.

2. Buka berkas `Code.gs`, hapus isinya, lalu tempel seluruh isi `code.gs` dari folder ini.
3. Simpan (Ctrl+S).
4. Jalankan fungsi `cekStruktur` sekali (dropdown di atas editor → Run) untuk
   memicu izin akses. Di **Execution log** harus terlihat header terdeteksi, misalnya
   `Pemasukan: header di baris 1, kolom (mulai 0) = {"date":1,"amount":2,"category":3,"note":6}`.
5. Klik **Deploy → Manage deployments**.
6. Pada deployment yang sudah ada, klik ikon **pensil (Edit)**.
7. Isi:
   - **Version:** `New version`
   - **Execute as:** `Me (email Anda)`
   - **Who has access:** `Anyone` (Siapa saja)
8. Klik **Deploy**, lalu **Authorize access** bila diminta.
9. Salin **Web app URL** yang berakhiran `/exec`.

Jika URL berubah, samakan dengan konstanta `API_URL` di baris atas `app.js`.

### Opsional: kunci API

API bisa dipanggil siapa pun yang memiliki URL. Untuk mengunci:

1. Di `code.gs`, isi `const API_TOKEN = 'kata-sandi-panjang-anda';`
2. Deploy ulang (langkah di atas).
3. Di `app.js`, isi `const API_TOKEN = 'kata-sandi-panjang-anda';` lalu unggah ulang.

---

## 2. Unggah tampilan

Unggah **seluruh berkas** berikut ke satu folder yang sama:

```
index.html
styles.css
app.js
manifest.json
sw.js
icon.svg
icon-maskable.svg
```

Hosting gratis yang cocok: GitHub Pages, Netlify Drop, atau Cloudflare Pages.
Aplikasi harus dibuka lewat `https://` agar bisa di-install dan bekerja offline.
Membuka `index.html` langsung dari penyimpanan lokal (`file://`) tetap bisa untuk
melihat tampilan, tetapi service worker dan mode offline tidak aktif.

---

## 3. Tambahkan ke layar utama HP

- **Android (Chrome):** buka URL → menu ⋮ → **Tambahkan ke layar utama / Instal aplikasi**.
- **iPhone (Safari):** buka URL → tombol Bagikan → **Tambahkan ke Layar Utama**.

---

## 4. Checklist pengujian

1. **Muat data** — dashboard menampilkan saldo, pemasukan, dan pengeluaran dari sheet.
2. **Kantong dana** — kartu **Kantong dana** menampilkan daftar kantong dari sheet **SumberDana** beserta saldonya (SaldoAwal + pemasukan − pengeluaran).
3. **Tambah pengeluaran** — tekan `+`, isi nominal, pilih kategori, lalu **Diambil dari kantong** (chip menampilkan saldo tiap kantong). Peringatan muncul bila nominal melebihi saldo, tetapi tetap bisa disimpan. Baris baru muncul di sheet **Pengeluaran** (kolom SumberDana terisi) dan tidak ada data lama yang bergeser/tertimpa.
4. **Tambah pemasukan** — ubah jenis ke Pemasukan; label berubah menjadi **Uang masuk ke kantong**, pilih kantong tujuan, simpan. Baris masuk ke sheet **Pemasukan** beserta kantongnya.
5. **Format nominal** — mengetik `2500000` menampilkan `2.500.000`, tersimpan sebagai angka.
6. **Validasi** — nominal `0`, kategori kosong, atau kantong belum dipilih ditolak dengan pesan jelas.
7. **Edit** — ketuk transaksi → **Edit transaksi** → ubah nominal/kantong → simpan. Baris yang sama di sheet ikut berubah.
8. **Hapus** — ketuk transaksi → **Hapus transaksi** → konfirmasi. Baris hilang dari sheet.
9. **Filter periode** — Hari ini / 7 hari / Bulan ini / Custom mengubah saldo, grafik, dan insight.
10. **Riwayat** — pencarian (termasuk nama kantong) dan filter jenis/kategori menyaring daftar.
11. **Offline** — matikan data seluler, buka aplikasi: data terakhir tetap tampil dengan banner offline; menyimpan ditolak dengan pesan, bukan diam-diam gagal.
12. **Layar kecil** — uji di lebar 320px: tidak ada teks terpotong atau scroll horizontal.

---

## 5. Jika ada masalah

| Pesan / gejala | Penyebab & solusi |
| --- | --- |
| "Cannot read properties of null (reading 'getSheetByName')" | Project Apps Script standalone dan `SPREADSHEET_ID` kosong/salah. Isi ID dari URL spreadsheet, atau buat project dari menu Extensions di spreadsheet. |
| "Server mengirim respons yang tidak dikenali" | `code.gs` belum dideploy ulang, atau akses bukan `Anyone`. Ulangi bagian 1. |
| "Spreadsheet ... tidak bisa dibuka" | Akun pemilik deployment tidak punya akses edit ke file spreadsheet. |
| "Sheet 'Pemasukan' tidak ditemukan" | Nama sheet berbeda (spasi/huruf besar). Sesuaikan `SHEET_NAMES` di `code.gs`. |
| "Header sheet tidak dikenali" | Baris header harus memuat kolom Tanggal dan Nominal/Jumlah di 5 baris teratas. |
| Kartu kantong dana tidak muncul | `code.gs` belum dideploy ulang, sheet **SumberDana** tidak ada, atau kolom **Nama** di sheet itu kosong semua. |
| Saldo kantong di sheet tidak berubah | Kolom `SaldoSaatIni` berisi rumus (sengaja tidak ditimpa) atau `SYNC_SALDO` di `code.gs` di-set `false`. |
| "Baris ini sudah berubah di spreadsheet" | Baris diedit manual di sheet. Muat ulang data, lalu ulangi perubahan. |
| Perubahan di sheet tidak muncul di aplikasi | Tekan ikon ⟳ di kanan atas (atau menu Setelan → Muat ulang data). |
| Tampilan/kode lama masih muncul setelah upload | Service worker menyajikan cache lama. Muat ulang 2×; bila tetap, buka setelan situs di browser → **Hapus data situs** (atau uninstall lalu pasang ulang PWA). Sejak v4, cache memakai strategi network-first + URL berversi (`app.js?v=4`). |
| Ikon di layar utama polos (iPhone) | Safari belum mendukung ikon SVG. Tambahkan `apple-touch-icon` berformat PNG bila perlu. |

---

## 6. Catatan struktur data

### Sheet transaksi (Pemasukan / Pengeluaran)

Lima kolom dipakai, dideteksi otomatis dari header:

- **Tanggal** (`tanggal`, `tgl`, `date`, `waktu`)
- **Nominal** (`nominal`, `jumlah`, `nilai`, `amount`, `harga`)
- **Sumber Dana** (`sumberdana`, `sumber dana`, `dana`, `kantong`, `wallet`, `akun`, `rekening`)
- **Kategori** (`kategori`, `category`, `jenis`)
- **Catatan** (`catatan`, `keterangan`, `deskripsi`, `note`, `memo`)

Kolom lain tidak diubah. Rumus dan format baris terakhir diteruskan ke baris baru.
Bila Kategori, Catatan, atau Sumber Dana tidak ada, bagian terkait otomatis disembunyikan.

### Sheet kantong (SumberDana)

- Dibaca dari sheet bernama `SumberDana` (ubah `SHEET_NAMES.wallets` bila berbeda).
- Kolom: `ID`, `Nama`, `Tipe`, `SaldoAwal`, `SaldoSaatIni`, `Icon`, `Status`, `Catatan`.
- Baris dengan **Nama kosong** dilewati, sehingga sisa baris lama tidak muncul sebagai kantong kosong.
- Saldo dihitung: `SaldoAwal + pemasukan − pengeluaran` per nama kantong (tidak peka huruf besar/kecil).
- Kolom `SaldoSaatIni` ikut diperbarui setiap ada tambah/edit/hapus transaksi. Sel yang berisi
  **rumus tidak ditimpa**; set `SYNC_SALDO = false` di `code.gs` bila tidak ingin kolom itu disentuh.
- Aplikasi tidak membuat atau menghapus baris di sheet ini — kantong baru ditambahkan manual di sheet.

