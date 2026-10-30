# Pesan Makan Siang

Web pemesanan makan siang harian. Pesanan dikumpulkan dalam **satu batch per hari**.
Batch ditutup otomatis pada jam tutup (default **11.00 WIB**, bisa diubah di halaman admin), lalu rekapnya (teks + gambar PNG) dikirim
ke nomor WhatsApp yang ditentukan.

## Fitur (iterasi 1)

- Form pemesanan: nama, makanan (**free text**), jumlah, catatan opsional.
- Satu batch per hari (tanggal WIB), ditutup pada jam tutup yang diatur di halaman admin (default 11.00 WIB).
  Form selalu bisa diisi: sebelum cutoff pesanan masuk batch hari ini, setelah cutoff otomatis
  masuk batch besok. Penentuan batch dilakukan di server, bukan di browser.
- Daftar pesanan untuk batch yang sedang dibuka tampil di halaman form.
- Setelah cutoff, scheduler:
  1. menutup batch,
  2. membuat rekap teks (format WhatsApp) dan gambar PNG,
  3. mengirimkannya via WhatsApp, dengan retry otomatis bila gagal (default 5× dengan jeda 5 menit).
- Menu free text dikelompokkan longgar di ringkasan: `Nasi Goreng` dan `nasi  goreng` dihitung sebagai menu yang sama.
- Halaman admin (`/admin`, butuh `ADMIN_TOKEN`): atur **jam tutup**, lihat pesanan per tanggal, hapus pesanan,
  pratinjau rekap teks/gambar, kirim ulang rekap secara manual, dan **reset batch** hari ini.

### Jam tutup

Diatur di kartu **Pengaturan** pada `/admin`, disimpan di database, dan langsung berlaku tanpa restart.
Bila diubah di tengah hari:

- dimajukan ke jam yang sudah lewat → batch hari ini langsung ditutup dan rekapnya dikirim (ada konfirmasi dulu);
- dimundurkan padahal batch hari ini sudah ditutup/terkirim → admin ditawari membuka kembali batch hari ini.

### Reset batch

Rekap otomatis dikirim **satu kali per batch**. Setelah terkirim, batch berstatus "Terkirim" dan
tidak dikirim otomatis lagi, walaupun jam tutup atau `WA_PROVIDER` diubah di hari yang sama.
Tombol **Reset batch** di `/admin` (hanya untuk batch hari ini) mengembalikan batch ke status
dibuka. Pesanan yang sudah ada tetap tersimpan, sedangkan riwayat penutupan dan pengiriman dihapus:

- jika jam tutup belum lewat, form kembali menerima pesanan untuk hari ini dan rekap dikirim otomatis pada jam tutup;
- jika jam tutup sudah lewat, batch langsung ditutup lagi dan rekap dikirim ulang otomatis dalam ±30 detik.

## Menjalankan

Butuh Node.js ≥ 22.13 (cek dengan `node -v`). Tidak perlu Python atau build tools: database memakai SQLite bawaan Node.js (`node:sqlite`).

```bash
npm install
cp .env.example .env   # lalu sesuaikan isinya
npm start              # http://localhost:3000
```

Data disimpan di SQLite (`data/app.db`) atau Turso jika `TURSO_DATABASE_URL` diatur.

```bash
npm test
```

## Deploy ke Netlify

1. Buat database di [Turso](https://turso.tech/) (free), catat **Database URL** dan buat **Auth Token**.
2. Push repository ini ke GitHub.
3. Di dashboard [Netlify](https://app.netlify.com/):
   - **Add new site** → **Import an existing project** → pilih repo Anda.
   - Atur **Environment variables**:
     - `TURSO_DATABASE_URL`: URL database Turso Anda (`libsql://...`)
     - `TURSO_AUTH_TOKEN`: Auth token Turso Anda
     - `ADMIN_TOKEN`: Token rahasia untuk `/admin`
     - `APP_TITLE`: Judul web (misal `Paragon MBG`)
     - `WA_PROVIDER`: Provider WhatsApp (`twilio`, `fonnte`, atau `cloudapi`)
     - `WA_TARGETS`: Nomor tujuan WhatsApp
     - Kredensial provider (misal `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`)
4. Klik **Deploy site**.
   - Netlify CDN otomatis menyajikan halaman publik (`public/`).
   - Endpoint API dilayani oleh Serverless Function (`netlify/functions/api.js`).
   - Jadwal pengiriman rekap dijalankan otomatis setiap 5 menit oleh Scheduled Function (`netlify/functions/cron.js`).

## Konfigurasi WhatsApp

Atur `WA_PROVIDER` di `.env`:

| Provider   | Keterangan |
|------------|------------|
| `console`  | Default untuk uji coba. Tidak mengirim apa pun; rekap disimpan ke `data/outbox/`. |
| `fonnte`   | Via [Fonnte](https://fonnte.com), gateway yang umum dipakai di Indonesia. Isi `FONNTE_TOKEN`. Pengiriman file/gambar memerlukan paket Fonnte yang mendukung upload file. `WA_TARGETS` boleh berisi ID grup. |
| `cloudapi` | WhatsApp Business Cloud API resmi dari Meta. Isi `WA_CLOUD_TOKEN` dan `WA_CLOUD_PHONE_NUMBER_ID`. **Catatan:** Meta hanya mengizinkan pesan bebas (non-template) dalam 24 jam setelah penerima terakhir mengirim pesan ke nomor bisnis. Di luar jendela itu, perlu template yang disetujui. |
| `twilio`   | Via [Twilio](https://www.twilio.com/docs/whatsapp), BSP resmi WhatsApp. Isi `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, dan `TWILIO_WHATSAPP_FROM`. Hanya mengirim teks (gambar rekap diabaikan). Untuk sandbox, penerima harus mengirim kode join terlebih dahulu. |

`WA_TARGETS` berisi nomor tujuan dalam format internasional tanpa `+`, misalnya `6281234567890`.
Beberapa nomor dipisahkan dengan koma.

## Catatan perilaku

- Scheduler mengecek setiap 30 detik, tidak bergantung pada cron sekali jalan. Jika server mati
  tepat pukul 11.00, rekap tetap dikirim begitu server menyala lagi (pada hari yang sama).
- Jika batch kosong, rekap "tidak ada pesanan" tetap dikirim. Ubah `SEND_WHEN_EMPTY=false` untuk menonaktifkannya.
- Gambar rekap memakai font Inter yang sudah dibundel di `assets/fonts` (lisensi OFL), sehingga tampilannya konsisten di server mana pun.

## Struktur

```
src/
  server.js     Express app & route API
  config.js     Pembacaan konfigurasi (.env)
  time.js       Helper tanggal/jam WIB
  db.js         Skema SQLite
  batch.js      Logika batch harian & validasi pesanan
  recap.js      Pembuatan rekap teks dan gambar (SVG → PNG)
  scheduler.js  Penutupan batch & pengiriman rekap
  whatsapp.js   Provider WhatsApp (console, fonnte, cloudapi)
public/         Halaman form (index) dan admin
test/           Unit test (node:test)
```
