/**
 * ============================================================
 *  KONFIGURASI DATA UNTUK BOT PENGISI FORM
 *  Report Data Lead AE - MoraRepublic Jawa Tengah Utara
 * ============================================================
 * 
 *  Sesuaikan data di bawah ini dengan kebutuhan Anda.
 *  Bot akan memilih data secara RANDOM dari array yang disediakan.
 */

module.exports = {
  // ── PIN untuk Akses Bot Dashboard ──────────────────────────
  // PIN default untuk mengakses dashboard. Silakan ganti dengan PIN pilihan Anda.
  BOT_PIN: process.env.BOT_PIN || '1234',

  // ── URL Form ──────────────────────────────────────────────
  FORM_URL: 'https://script.google.com/macros/s/AKfycbwSM6dh2oTU3SPgEwmSCCbdncvAUXry3IW61DFJUad5EJ38wzHc5FZIhQBgxRR4lAc3/exec',

  // ── Berapa kali form disubmit ─────────────────────────────
  TOTAL_SUBMISSIONS: 5,

  // ── Jeda antar submission (milidetik) ─────────────────────
  // Minimum dan maximum delay (random antara keduanya)
  DELAY_MIN_MS: 3000,
  DELAY_MAX_MS: 6000,

  // ── Pilihan Area ──────────────────────────────────────────
  // Pilih salah satu: 'REGULER' atau 'RING & ECO'
  AREA: 'REGULER',

  // ── Tampilkan browser saat berjalan ───────────────────────
  // true  = browser terlihat (untuk debugging/melihat proses)
  // false = headless / browser tersembunyi (lebih cepat)
  SHOW_BROWSER: true,

  // ── Data untuk mengisi form ───────────────────────────────
  // Bot akan memilih secara RANDOM dari daftar ini setiap kali submit
  
  // Daftar Nama Calon Pelanggan (Capel)
  NAMA_CAPEL: [
    'Budi Santoso',
    'Siti Rahayu',
    'Ahmad Pratama',
    'Dewi Lestari',
    'Rizki Ramadhan',
    'Fitri Handayani',
    'Agus Supriyanto',
    'Rina Wulandari',
    'Dimas Aditya',
    'Sri Wahyuni',
  ],

  // Daftar Nomor HP (harus unik! Bot akan generate random jika habis)
  // Format: 08xxxxxxxxxx (10-15 digit)
  NO_HP_CAPEL: [
    '081234567001',
    '081234567002',
    '081234567003',
    '081234567004',
    '081234567005',
    '081234567006',
    '081234567007',
    '081234567008',
    '081234567009',
    '081234567010',
  ],

  // Daftar Alamat
  ALAMAT_CAPEL: [
    'Jl. Merpati No. 10, RT 03/RW 05, Kel. Semarang Tengah',
    'Jl. Kenari No. 25, Perum Green Valley Blok A3',
    'Jl. Anggrek Raya No. 7, Cluster Harmony Residence',
    'Jl. Mawar No. 88, Perumahan Griya Asri Indah',
    'Jl. Dahlia No. 15, Komplek Permata Hijau',
    'Jl. Melati No. 33, RT 01/RW 02, Dekat Masjid Al-Ikhlas',
    'Jl. Flamboyan No. 5, Perum Citra Garden',
    'Jl. Teratai No. 12, Graha Pesona Residence',
    'Jl. Bougenville No. 9, RT 04/RW 03',
    'Jl. Kamboja No. 21, Dekat SD Negeri 1',
  ],

  // Daftar ISP yang digunakan saat ini
  ISP: [
    'Indihome',
    'Biznet',
    'MNC Play',
    'First Media',
    'MyRepublic',
    'Tidak Ada',
    'CBN',
    'Oxygen',
    'Iconnet',
    'XL Home',
  ],

  // Daftar Status Lead
  // Pilihan: 'COOL', 'WARM', 'HOT', 'CLOSING'
  STATUS_LEAD: [
    'COOL',
    'WARM',
    'HOT',
    'CLOSING',
  ],

  // ── Opsi Nomor HP Otomatis ────────────────────────────────
  // Jika true, bot akan generate nomor HP random (08 + 10 digit random)
  // Berguna agar tidak terkena validasi duplikat
  AUTO_GENERATE_HP: true,
};
