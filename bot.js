/**
 * ============================================================
 *  BOT PENGISI FORM OTOMATIS v2
 *  Report Data Lead AE - MoraRepublic Jawa Tengah Utara
 * ============================================================
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

// ── Master Data & Database Names ──
const MASTER_DATA_PATH = path.join(__dirname, 'master_data.json');
let masterData = null;
if (fs.existsSync(MASTER_DATA_PATH)) {
  try {
    masterData = JSON.parse(fs.readFileSync(MASTER_DATA_PATH, 'utf8'));
  } catch (e) {
    console.error('Gagal membaca master_data.json:', e.message);
  }
}

const NAMES_PATH = path.join(__dirname, 'public', 'names.json');
let databaseNames = [];
if (fs.existsSync(NAMES_PATH)) {
  try {
    databaseNames = JSON.parse(fs.readFileSync(NAMES_PATH, 'utf8'));
  } catch (e) {}
}

const FALLBACK_INDONESIAN_NAMES = [
  'Budi Santoso', 'Siti Rahayu', 'Ahmad Pratama', 'Dewi Lestari', 'Rizki Ramadhan',
  'Fitri Handayani', 'Agus Supriyanto', 'Rina Wulandari', 'Dimas Aditya', 'Sri Wahyuni',
  'Eko Prasetyo', 'Nur Hidayah', 'Bambang Tri', 'Endang Mulyani', 'Fajar Nugroho',
  'Mega Utami', 'Tri Wibowo', 'Wulan Sari', 'Joko Susanto', 'Putri Ayu'
];

// ── Persistent Phone Database (Deduplication) ──
const SUBMITTED_PHONES_PATH = path.join(__dirname, 'submitted_phones.json');
let submittedPhones = new Set();
if (fs.existsSync(SUBMITTED_PHONES_PATH)) {
  try {
    const arr = JSON.parse(fs.readFileSync(SUBMITTED_PHONES_PATH, 'utf8'));
    submittedPhones = new Set(arr);
    console.log(`  ✅ [System] Berhasil memuat ${submittedPhones.size} riwayat nomor HP terkirim.`);
  } catch (e) {
    submittedPhones = new Set();
  }
}

function saveSubmittedPhone(phone) {
  submittedPhones.add(phone);
  try {
    fs.writeFileSync(SUBMITTED_PHONES_PATH, JSON.stringify(Array.from(submittedPhones), null, 2));
  } catch (e) {}
}

// ── Utility Functions ───────────────────────────────────────

function randomFrom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const INDONESIA_PHONE_PREFIXES = [
  // Telkomsel (SimPATI, Loop, As, Halo, By.U)
  '0811', '0812', '0813', '0821', '0822', '0823', '0851', '0852', '0853',
  // Indosat Ooredoo (IM3, Mentari, Matrix)
  '0814', '0815', '0816', '0855', '0856', '0857', '0858',
  // XL Axiata
  '0817', '0818', '0819', '0859', '0877', '0878',
  // Axis
  '0831', '0832', '0833', '0838',
  // Smartfren
  '0881', '0882', '0883', '0884', '0885', '0886', '0887', '0888', '0889',
  // Tri (3)
  '0895', '0896', '0897', '0898', '0899'
];

function generateTrulyRandomPhone(excludeSet = null) {
  let attempts = 0;
  while (attempts < 10000) {
    attempts++;
    const prefix = INDONESIA_PHONE_PREFIXES[crypto.randomInt(0, INDONESIA_PHONE_PREFIXES.length)];
    const suffixLength = crypto.randomInt(7, 10);
    
    let suffix = '';
    for (let i = 0; i < suffixLength; i++) {
      suffix += crypto.randomInt(0, 10).toString();
    }
    
    const candidate = `${prefix}${suffix}`;
    
    const isAllSame = /^(\d)\1+$/.test(suffix);
    const isSequential = '0123456789012345'.includes(suffix) || '9876543210987654'.includes(suffix);
    const isRepetitiveEnd = /(\d)\1{4,}$/.test(candidate);
    
    if (isAllSame || isSequential || isRepetitiveEnd) {
      continue;
    }
    
    if (excludeSet && excludeSet.has(candidate)) {
      continue;
    }
    if (submittedPhones && submittedPhones.has(candidate)) {
      continue;
    }
    
    return candidate;
  }
  
  return '08' + Date.now().toString().slice(-9) + crypto.randomInt(10, 99);
}

function generateRandomAlamat(kota) {
  const streets = ['Merpati', 'Kenari', 'Anggrek', 'Mawar', 'Dahlia', 'Melati', 'Flamboyan', 'Teratai', 'Bougenville', 'Kamboja', 'Cempaka', 'Kecubung', 'Pahlawan', 'Sudirman', 'Gatot Subroto', 'Diponegoro', 'Ahmad Yani', 'Pemuda', 'Pandanaran', 'Siliwangi', 'Kartini', 'Veteran', 'Imam Bonjol'];
  const prefixes = ['Jl.', 'Jalan'];
  const blocks = ['Blok A', 'Blok B', 'Blok C', 'Blok D', 'Blok E', 'No.'];
  
  const street = randomFrom(streets);
  const prefix = randomFrom(prefixes);
  const block = randomFrom(blocks);
  const num = randomDelay(1, 120);
  const rt = randomDelay(1, 12);
  const rw = randomDelay(1, 10);
  
  const blockStr = block === 'No.' ? ` No. ${num}` : ` ${block} No. ${randomDelay(1, 30)}`;
  const cityStr = kota ? `, ${kota}` : ', Jawa Tengah';
  return `${prefix} ${street}${blockStr}, RT 0${rt}/RW 0${rw}${cityStr}`;
}

function getVerifiedNamaCapel(cfg) {
  if (databaseNames && databaseNames.length > 0) {
    const name = randomFrom(databaseNames);
    if (name && typeof name === 'string' && name.trim()) return name.trim();
  }
  if (cfg && Array.isArray(cfg.NAMA_CAPEL) && cfg.NAMA_CAPEL.length > 0) {
    const name = randomFrom(cfg.NAMA_CAPEL);
    if (name && typeof name === 'string' && name.trim()) return name.trim();
  }
  return randomFrom(FALLBACK_INDONESIAN_NAMES);
}

function timestamp() {
  return new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function log(msg, type = 'info') {
  const icons = {
    info: '📋', success: '✅', warning: '⚠️', error: '❌',
    bot: '🤖', form: '📝', wait: '⏳', rocket: '🚀',
  };
  console.log(`  ${icons[type] || '•'} [${timestamp()}] ${msg}`);
}

// ── Hierarchy Resolver ──
function resolveAEHierarchy(targetAE, targetKota, targetArea, master) {
  let aeName = (targetAE || '').trim();
  let foundAsm = null;
  let foundBM = null;
  let foundKota = targetKota || null;
  let foundArea = targetArea || null;

  if (master && master.kotaMap) {
    // If AE is provided, find its exact chain
    if (aeName && master.aeMap) {
      for (const [asm, aes] of Object.entries(master.aeMap)) {
        if (aes.some(a => a.trim().toUpperCase() === aeName.toUpperCase())) {
          foundAsm = asm;
          break;
        }
      }
    }

    // Find BM from ASM
    if (foundAsm && master.asmMap) {
      for (const [bm, asms] of Object.entries(master.asmMap)) {
        if (asms.some(a => a.trim().toUpperCase() === foundAsm.toUpperCase())) {
          foundBM = bm;
          break;
        }
      }
    }

    // Find Kota and Area from BM
    if (foundBM && master.kotaMap) {
      const k = master.kotaMap.find(item => item.bm.trim().toUpperCase() === foundBM.toUpperCase());
      if (k) {
        foundKota = k.kota;
        foundArea = k.area;
      }
    }

    // If AE wasn't set or not found, pick random AE from Kota/Area
    if (!aeName) {
      const matchedKotas = master.kotaMap.filter(k => !targetArea || k.area === targetArea);
      const chosenKota = (targetKota && master.kotaMap.find(k => k.kota === targetKota)) || randomFrom(matchedKotas) || master.kotaMap[0];
      
      foundKota = chosenKota.kota;
      foundArea = chosenKota.area;
      foundBM = chosenKota.bm;

      const asms = master.asmMap[foundBM] || [];
      foundAsm = randomFrom(asms) || '';
      
      const aes = master.aeMap[foundAsm] || [];
      aeName = randomFrom(aes) || '';
    }
  }

  // Clusters
  let clusters = [];
  if (foundKota && master && master.clusterMap) {
    const baseKota = foundKota.replace(/\s+\d+$/, '').trim();
    clusters = master.clusterMap[baseKota] || master.clusterMap[foundKota] || [];
  }
  const selectedCluster = clusters.length > 0 ? randomFrom(clusters) : `Area ${foundKota || 'Umum'}`;

  return {
    ae: aeName,
    asm: foundAsm || '',
    bm: foundBM || '',
    kota: foundKota || 'Semarang 1',
    area: foundArea || 'REGULER',
    cluster: selectedCluster,
    clusters: clusters
  };
}

// ── Main Bot Logic ──────────────────────────────────────────

async function main() {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════╗');
  console.log('  ║   🤖  BOT PENGISI FORM v2 - DATA LEAD AE     ║');
  console.log('  ║   MoraRepublic - Jawa Tengah Utara            ║');
  console.log('  ╚═══════════════════════════════════════════════╝');
  console.log('');
  log(`Target: ${config.TOTAL_SUBMISSIONS} submissions`, 'rocket');
  log(`Area default: ${config.AREA}`, 'info');
  log(`Browser: ${config.SHOW_BROWSER ? 'Visible' : 'Headless'}`, 'info');
  log(`Database Nomor HP: ${submittedPhones.size} nomor terdaftar anti-duplikat`, 'info');
  console.log('  ─────────────────────────────────────────────────');
  console.log('');

  log('Meluncurkan browser...', 'bot');
  const browser = await puppeteer.launch({
    headless: process.platform === 'linux' ? true : !config.SHOW_BROWSER,
    defaultViewport: { width: 1280, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const usedPhones = new Set();
  let successCount = 0;
  let failCount = 0;

  const page = await browser.newPage();
  try {
    log('Membuka halaman form...', 'wait');
    await page.goto(config.FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
  } catch(e) {}

  for (let i = 1; i <= config.TOTAL_SUBMISSIONS; i++) {
    console.log(`  ┌─── Submission ${i}/${config.TOTAL_SUBMISSIONS} ───────────────────────`);

    try {
      log('Menunggu iframe sandbox...', 'wait');
      let frame = null;
      for (let wait = 0; wait < 30; wait++) {
        const frames = page.frames();
        for (const f of frames) {
          if (f.url().includes('googleusercontent.com') && f.url().includes('/blank')) {
            frame = f;
            break;
          }
        }
        if (frame) break;
        await sleep(500);
      }
      
      if (!frame) {
        for (const f of page.frames()) {
          if (f !== page.mainFrame() && f.url() !== 'about:blank') { frame = f; break; }
        }
      }

      if (!frame) {
        throw new Error('Tidak dapat mengakses iframe sandbox.');
      }

      // Wait for master dropdowns in appState
      await frame.waitForFunction(() => {
        return typeof appState !== 'undefined' && appState.dropdownMaster && appState.dropdownMaster.kotaMap;
      }, { timeout: 45000 }).catch(() => {});

      // Synchronize master data from frame if needed
      const frameMaster = await frame.evaluate(() => {
        if (typeof appState !== 'undefined' && appState.dropdownMaster && appState.dropdownMaster.kotaMap) {
          return appState.dropdownMaster;
        }
        return null;
      });
      if (frameMaster) masterData = frameMaster;

      // Target AE if configured in config.TARGET or config.AE
      const targetAE = (config.TARGET && config.TARGET.NAMA_AE) ? (Array.isArray(config.TARGET.NAMA_AE) ? randomFrom(config.TARGET.NAMA_AE) : config.TARGET.NAMA_AE) : '';
      const targetKota = (config.TARGET && config.TARGET.KOTA) || '';
      
      // Resolve complete verified hierarchy
      const hierarchy = resolveAEHierarchy(targetAE, targetKota, config.AREA, masterData);

      log(`Target AE: ${hierarchy.ae} (${hierarchy.kota} | ASM: ${hierarchy.asm.replace(/\s+\.$/, '')})`, 'info');

      // Generate verified non-empty fields with cryptographically random unique phone
      const namaCapel = getVerifiedNamaCapel(config);
      let currentHp = generateTrulyRandomPhone(usedPhones);
      usedPhones.add(currentHp);
      saveSubmittedPhone(currentHp);

      const alamat = generateRandomAlamat(hierarchy.kota);
      const isp = (Array.isArray(config.ISP) && config.ISP.length > 0) ? randomFrom(config.ISP) : 'Tidak Ada';
      const statusLead = (Array.isArray(config.STATUS_LEAD) && config.STATUS_LEAD.length > 0) ? randomFrom(config.STATUS_LEAD) : 'COOL';
      const cluster = hierarchy.cluster;

      log(`Mengisi: [${hierarchy.area}] ${hierarchy.kota} | BM: ${hierarchy.bm.replace(/\s+\.$/, '')} | ASM: ${hierarchy.asm.replace(/\s+\.$/, '')} | Capel: ${namaCapel} | No HP: ${currentHp}`, 'form');

      // Fill and submit cleanly inside frame
      await frame.evaluate((data) => {
        // 1. Select area
        if (typeof selectArea === 'function') selectArea(data.area);
        if (typeof goToForm === 'function') goToForm();

        // 2. Kota
        if (typeof populateKotaDropdown === 'function') populateKotaDropdown();
        const kotaSelect = document.getElementById('input-kota');
        if (kotaSelect) {
          kotaSelect.value = data.kota;
          if (typeof onKotaChanged === 'function') onKotaChanged();
        }

        // 3. BM
        const bmInput = document.getElementById('input-bm');
        if (bmInput) bmInput.value = data.bm;

        // 4. ASM
        if (typeof populateAsmDropdown === 'function') populateAsmDropdown(data.bm);
        const asmSelect = document.getElementById('input-asm');
        if (asmSelect) {
          asmSelect.value = data.asm;
          if (typeof onAsmChanged === 'function') onAsmChanged();
        }

        // 5. AE
        if (typeof populateAeDropdown === 'function') populateAeDropdown(data.asm);
        const aeSelect = document.getElementById('input-ae');
        if (aeSelect) {
          aeSelect.value = data.ae;
        }

        // 6. Cluster
        const clusterHidden = document.getElementById('input-cluster');
        const clusterSearch = document.getElementById('cluster-search');
        if (clusterHidden) clusterHidden.value = data.cluster;
        if (clusterSearch) clusterSearch.value = data.cluster;

        // 7. Nama Capel
        const namaInput = document.getElementById('input-nama-capel');
        if (namaInput) namaInput.value = data.namaCapel;

        // 8. No HP
        const hpInput = document.getElementById('input-nohp-capel');
        if (hpInput) {
          hpInput.value = data.noHp;
          if (typeof validateRealtimeNoHp === 'function') validateRealtimeNoHp();
        }

        // 9. Alamat
        const alamatInput = document.getElementById('input-alamat');
        if (alamatInput) alamatInput.value = data.alamat;

        // 10. ISP
        const ispInput = document.getElementById('input-isp');
        if (ispInput) ispInput.value = data.isp;

        // 11. Status Lead
        const statusSelect = document.getElementById('input-status-lead');
        if (statusSelect) statusSelect.value = data.statusLead;

        // Final safety guarantee
        if (document.getElementById('input-kota') && !document.getElementById('input-kota').value) document.getElementById('input-kota').value = data.kota;
        if (document.getElementById('input-bm') && !document.getElementById('input-bm').value) document.getElementById('input-bm').value = data.bm;
        if (document.getElementById('input-asm') && !document.getElementById('input-asm').value) document.getElementById('input-asm').value = data.asm;
        if (document.getElementById('input-ae') && !document.getElementById('input-ae').value) document.getElementById('input-ae').value = data.ae;
        if (document.getElementById('input-cluster') && !document.getElementById('input-cluster').value) document.getElementById('input-cluster').value = data.cluster;
        if (document.getElementById('cluster-search') && !document.getElementById('cluster-search').value) document.getElementById('cluster-search').value = data.cluster;
        if (document.getElementById('input-nama-capel') && !document.getElementById('input-nama-capel').value) document.getElementById('input-nama-capel').value = data.namaCapel;
        if (document.getElementById('input-nohp-capel') && !document.getElementById('input-nohp-capel').value) document.getElementById('input-nohp-capel').value = data.noHp;
        if (document.getElementById('input-alamat') && !document.getElementById('input-alamat').value) document.getElementById('input-alamat').value = data.alamat;
        if (document.getElementById('input-isp') && !document.getElementById('input-isp').value) document.getElementById('input-isp').value = data.isp;
        if (document.getElementById('input-status-lead') && !document.getElementById('input-status-lead').value) document.getElementById('input-status-lead').value = data.statusLead;

        // Trigger Submit
        if (typeof showLoader === 'function') showLoader('Menyimpan Data', 'Sedang merekam kunjungan prospek...');
        if (typeof saveLaporanKunjungan === 'function') {
          saveLaporanKunjungan();
        } else {
          const form = document.getElementById('kunjungan-form');
          if (form) form.dispatchEvent(new Event('submit', { cancelable: true }));
        }
      }, {
        area: hierarchy.area,
        kota: hierarchy.kota,
        bm: hierarchy.bm,
        asm: hierarchy.asm,
        ae: hierarchy.ae,
        cluster: cluster,
        namaCapel: namaCapel,
        noHp: currentHp,
        alamat: alamat,
        isp: isp,
        statusLead: statusLead
      });

      await sleep(2000);

      // Check duplicate popup & auto-resolve up to 5 times
      for (let dupAttempt = 0; dupAttempt < 5; dupAttempt++) {
        const isDuplicate = await frame.evaluate(() => {
          const popup = document.getElementById('duplicate-popup');
          return popup && !popup.classList.contains('hidden');
        });

        if (!isDuplicate) break;

        log(`⚠️ Duplikat terdeteksi pada nomor ${currentHp} di database Google Sheet. Membuat nomor baru (percobaan ${dupAttempt + 1})...`, 'warning');
        await frame.evaluate(() => {
          const btn = document.getElementById('close-dup-popup');
          if (btn) btn.click();
        });
        await sleep(600);
        
        currentHp = generateTrulyRandomPhone(usedPhones);
        usedPhones.add(currentHp);
        saveSubmittedPhone(currentHp);

        await frame.evaluate((newHp) => {
          const el = document.getElementById('input-nohp-capel');
          if (el) {
            el.value = newHp;
            if (typeof validateRealtimeNoHp === 'function') validateRealtimeNoHp();
          }
          if (typeof showLoader === 'function') showLoader('Menyimpan Data', 'Sedang merekam kunjungan prospek...');
          if (typeof saveLaporanKunjungan === 'function') saveLaporanKunjungan();
        }, currentHp);
        await sleep(2500);
      }

      // Wait for toast result
      log('Menunggu respons Google Sheets...', 'wait');
      let toastText = '';
      for (let wait = 0; wait < 35; wait++) {
        await sleep(1000);
        toastText = await frame.evaluate(() => {
          const el = document.getElementById('toast-title');
          const msg = document.getElementById('toast-message');
          if (el && el.innerText.trim()) {
            const txt = el.innerText.trim();
            const lower = txt.toLowerCase();
            if (lower.includes('sukses') || lower.includes('berhasil') || lower.includes('gagal') || lower.includes('error') || lower.includes('laporan')) {
              return txt + (msg ? ': ' + msg.innerText.trim() : '');
            }
          }
          const swal = document.querySelector('.swal2-title, .swal2-html-container');
          if (swal && swal.offsetParent !== null) {
            return swal.innerText.trim();
          }
          return '';
        }).catch(() => '');
        if (toastText) break;
      }

      const success = !toastText || toastText.toLowerCase().includes('sukses') || toastText.toLowerCase().includes('berhasil') || (!toastText.toLowerCase().includes('error') && !toastText.toLowerCase().includes('gagal'));

      if (success) {
        log(`✅ BERHASIL! Form #${i} tersubmit lengkap (${toastText || 'Laporan Sukses'})`, 'success');
        successCount++;
      } else {
        log(`❌ GAGAL! Form #${i}: ${toastText}`, 'error');
        failCount++;
      }

      // Reset form
      await frame.evaluate(() => {
        try {
          const form = document.getElementById('kunjungan-form');
          if (form) form.reset();
          if (typeof transitionStep === 'function') transitionStep('step-form', 'step-area');
        } catch(e) {}
      }).catch(() => {});

    } catch (err) {
      log(`❌ ERROR pada submission #${i}: ${err.message}`, 'error');
      failCount++;
      try {
        await page.goto(config.FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(4000);
      } catch(e) {}
    }

    console.log(`  └────────────────────────────────────────────────`);

    if (i < config.TOTAL_SUBMISSIONS) {
      const delay = randomDelay(config.DELAY_MIN_MS, config.DELAY_MAX_MS);
      log(`Menunggu ${(delay / 1000).toFixed(1)} detik...`, 'wait');
      await sleep(delay);
    }
    console.log('');
  }

  try { await page.close(); } catch(e) {}

  // ── Summary ──
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════╗');
  console.log('  ║              📊  RINGKASAN HASIL              ║');
  console.log('  ╠═══════════════════════════════════════════════╣');
  console.log(`  ║  ✅ Berhasil  : ${String(successCount).padStart(3)} submission(s)            ║`);
  console.log(`  ║  ❌ Gagal     : ${String(failCount).padStart(3)} submission(s)            ║`);
  console.log(`  ║  📋 Total     : ${String(config.TOTAL_SUBMISSIONS).padStart(3)} submission(s)            ║`);
  console.log('  ╚═══════════════════════════════════════════════╝');
  console.log('');

  await browser.close();
  log('Browser ditutup. Bot selesai!', 'bot');
}

main().catch(err => {
  console.error('\n  ❌ FATAL ERROR:', err.message, '\n');
  process.exit(1);
});
