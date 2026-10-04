/**
 * ============================================================
 *  SERVER DASHBOARD + BOT ENGINE
 *  Express + WebSocket + Puppeteer
 * ============================================================
 */

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');
const puppeteer = require('puppeteer');
const config = require('./config');

const serverStartTime = Date.now();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// WebSocket Connection Handshake Validation
wss.on('connection', (ws, req) => {
  try {
    const clientUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const clientPin = clientUrl.searchParams.get('pin');
    const expectedPin = config.BOT_PIN || '1234';

    if (!clientPin || clientPin !== expectedPin) {
      ws.send(JSON.stringify({ type: 'log', message: 'Koneksi WebSocket ditolak: PIN tidak valid.', level: 'error' }));
      ws.terminate();
      return;
    }
    
    // Kirim status bot saat ini agar client tersinkronisasi langsung saat konek
    ws.send(JSON.stringify({ type: 'status', status: botRunning ? 'running' : 'idle' }));
  } catch (err) {
    console.error('Error on WebSocket connection validation:', err.message);
    ws.terminate();
  }
});

const PORT = 3005;

// ── Middleware ──
app.use(express.json());

// Auth Middleware: Memeriksa PIN untuk semua request ke /api (kecuali verify-pin)
app.use((req, res, next) => {
  if (req.path.startsWith('/api') && req.path !== '/api/verify-pin') {
    const clientPin = req.headers['x-pin'];
    const expectedPin = config.BOT_PIN || '1234';
    if (!clientPin || clientPin !== expectedPin) {
      return res.status(401).json({ success: false, error: 'Unauthorized: PIN salah atau belum diisi.' });
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Database Names ──
const databaseNames = require('./public/names.json');
const fs = require('fs');

// ── Persistent Phone Database (Deduplication) ──
const SUBMITTED_PHONES_PATH = path.join(__dirname, 'submitted_phones.json');
let submittedPhones = new Set();
if (fs.existsSync(SUBMITTED_PHONES_PATH)) {
  try {
    const arr = JSON.parse(fs.readFileSync(SUBMITTED_PHONES_PATH, 'utf8'));
    submittedPhones = new Set(arr);
    console.log(`  ✅ [System] Berhasil memuat ${submittedPhones.size} database nomor HP terkirim.`);
  } catch(e) {
    console.log('  ⚠ [System] File submitted_phones.json rusak, mengosongkan...');
  }
}

function saveSubmittedPhone(phone) {
  submittedPhones.add(phone);
  try {
    fs.writeFileSync(SUBMITTED_PHONES_PATH, JSON.stringify(Array.from(submittedPhones), null, 2));
  } catch (e) {
    console.error('Gagal menulis database nomor HP:', e.message);
  }
}

// ── Master Dropdowns Cache & Extractor ──
let cachedMasterData = null;
const MASTER_DATA_PATH = path.join(__dirname, 'master_data.json');
let masterDataPromise = null;
const FORM_DEFAULT_URL = 'https://script.google.com/macros/s/AKfycbwSM6dh2oTU3SPgEwmSCCbdncvAUXry3IW61DFJUad5EJ38wzHc5FZIhQBgxRR4lAc3/exec';

async function getMasterDataFromForm(formUrl) {
  console.log('  ⏳ [System] Mengambil master data wilayah di background...');
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  });
  const page = await browser.newPage();
  try {
    await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Find the correct frame dynamically without static sleep
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
      await sleep(500); // Poll every 500ms
    }
    
    if (!frame) {
      // Fallback
      for (const f of frames) {
        if (f !== page.mainFrame()) { frame = f; break; }
      }
    }
    
    if (!frame) throw new Error('Tidak dapat menemukan iframe sandbox untuk data master');
    
    // Wait for DOM stability
    await frame.waitForSelector('[onclick*="selectArea"]', { timeout: 20000 });
    
    // Wait for spreadsheet dropdown data fetch dynamically
    console.log('  ⏳ [System] Menunggu sinkronisasi master data (bisa memakan waktu beberapa detik)...');
    await frame.waitForFunction(() => {
      return typeof appState !== 'undefined' && appState.dropdownMaster && appState.dropdownMaster.kotaMap;
    }, { timeout: 40000 }).catch(() => {});
    
    const masterData = await frame.evaluate(() => {
      if (typeof appState !== 'undefined' && appState.dropdownMaster && appState.dropdownMaster.kotaMap) {
        return {
          kotaMap: appState.dropdownMaster.kotaMap || [],
          asmMap: appState.dropdownMaster.asmMap || {},
          aeMap: appState.dropdownMaster.aeMap || {},
          clusterMap: appState.dropdownMaster.clusterMap || {}
        };
      }
      return null;
    });
    
    if (masterData) {
      fs.writeFileSync(MASTER_DATA_PATH, JSON.stringify(masterData, null, 2));
    }
    
    return masterData;
  } catch (err) {
    console.error('  ❌ [System] Gagal mengambil master data:', err.message);
    return null;
  } finally {
    await browser.close();
  }
}

// ── Bot State ──
let botRunning = false;
let botShouldStop = false;
let activeBrowsers = [];

// ── WebSocket Broadcast ──
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

function sendLog(message, level = 'info') {
  broadcast({ type: 'log', message, level });
}

function sendProgress(current, success, failed) {
  broadcast({ type: 'progress', current, success, failed });
}

function sendStatus(status) {
  broadcast({ type: 'status', status });
}

function sendResult(success, failed, total) {
  broadcast({ type: 'result', success, failed, total });
}

// ── Utilities ──
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
    // 1. Pick a random authentic Indonesian mobile prefix
    const prefix = INDONESIA_PHONE_PREFIXES[crypto.randomInt(0, INDONESIA_PHONE_PREFIXES.length)];
    
    // 2. Random realistic mobile length: 11, 12, or 13 digits (prefix 4 digits + 7, 8, or 9 random digits)
    const suffixLength = crypto.randomInt(7, 10);
    
    // 3. Generate high-entropy cryptographic digits
    let suffix = '';
    for (let i = 0; i < suffixLength; i++) {
      suffix += crypto.randomInt(0, 10).toString();
    }
    
    const candidate = `${prefix}${suffix}`;
    
    // 4. Anti-pattern filters (prevent repeating, sequential, or fake numbers)
    const isAllSame = /^(\d)\1+$/.test(suffix);
    const isSequential = '0123456789012345'.includes(suffix) || '9876543210987654'.includes(suffix);
    const isRepetitiveEnd = /(\d)\1{4,}$/.test(candidate);
    
    if (isAllSame || isSequential || isRepetitiveEnd) {
      continue;
    }
    
    // 5. Check against runtime and persistent database
    if (excludeSet && excludeSet.has(candidate)) {
      continue;
    }
    if (typeof submittedPhones !== 'undefined' && submittedPhones.has(candidate)) {
      continue;
    }
    
    return candidate;
  }
  
  // High-entropy fallback
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

const FALLBACK_INDONESIAN_NAMES = [
  'Budi Santoso', 'Siti Rahayu', 'Ahmad Pratama', 'Dewi Lestari', 'Rizki Ramadhan',
  'Fitri Handayani', 'Agus Supriyanto', 'Rina Wulandari', 'Dimas Aditya', 'Sri Wahyuni',
  'Eko Prasetyo', 'Nur Hidayah', 'Bambang Tri', 'Endang Mulyani', 'Fajar Nugroho',
  'Mega Utami', 'Tri Wibowo', 'Wulan Sari', 'Joko Susanto', 'Putri Ayu',
  'Wahyu Hidayat', 'Indah Permata', 'Hendra Wijaya', 'Ratna Juwita', 'Bayu Setiawan'
];

function getVerifiedNamaCapel(cfg) {
  if (cfg && cfg.useDatabaseNames && Array.isArray(databaseNames) && databaseNames.length > 0) {
    const name = randomFrom(databaseNames);
    if (name && typeof name === 'string' && name.trim()) return name.trim();
  }
  if (cfg && Array.isArray(cfg.namaCapel) && cfg.namaCapel.length > 0) {
    const name = randomFrom(cfg.namaCapel);
    if (name && typeof name === 'string' && name.trim()) return name.trim();
  }
  return randomFrom(FALLBACK_INDONESIAN_NAMES);
}

// ── Complete AE Hierarchy Resolver ──
function resolveAEHierarchy(aeItem, master) {
  const aeName = (typeof aeItem === 'object' ? (aeItem.name || aeItem.aeName || '') : (aeItem || '')).trim();
  const directArea = typeof aeItem === 'object' ? aeItem.area : null;
  const directKota = typeof aeItem === 'object' ? aeItem.kota : null;
  const directBM = typeof aeItem === 'object' ? aeItem.bm : null;
  const directASM = typeof aeItem === 'object' ? aeItem.asm : null;

  if (!master || !master.kotaMap) {
    return {
      ae: aeName,
      asm: directASM || '',
      bm: directBM || '',
      kota: directKota || '',
      area: directArea || 'REGULER',
      cluster: 'Cluster Umum',
      clusters: []
    };
  }

  // 1. Find ASM
  let foundAsm = directASM;
  if (!foundAsm && master.aeMap) {
    for (const [asm, aes] of Object.entries(master.aeMap)) {
      if (aes.some(a => a.trim().toUpperCase() === aeName.toUpperCase())) {
        foundAsm = asm;
        break;
      }
    }
  }

  // 2. Find BM
  let foundBM = directBM;
  if (!foundBM && foundAsm && master.asmMap) {
    for (const [bm, asms] of Object.entries(master.asmMap)) {
      if (asms.some(a => a.trim().toUpperCase() === foundAsm.toUpperCase())) {
        foundBM = bm;
        break;
      }
    }
  }

  // 3. Find Kota & Area
  let foundKota = directKota;
  let foundArea = directArea;
  if ((!foundKota || !foundArea) && master.kotaMap) {
    if (foundBM) {
      const k = master.kotaMap.find(item => item.bm.trim().toUpperCase() === foundBM.toUpperCase());
      if (k) {
        if (!foundKota) foundKota = k.kota;
        if (!foundArea) foundArea = k.area;
      }
    }
    if (!foundKota && directKota) {
      const k = master.kotaMap.find(item => item.kota.trim().toUpperCase() === directKota.toUpperCase());
      if (k) {
        foundKota = k.kota;
        if (!foundArea) foundArea = k.area;
      }
    }
  }

  // Fallbacks if not found
  if (!foundArea) foundArea = 'REGULER';
  if (!foundKota) {
    const k = master.kotaMap.find(item => item.area === foundArea) || master.kotaMap[0];
    if (k) {
      foundKota = k.kota;
      if (!foundBM) foundBM = k.bm;
    }
  }
  if (!foundBM && foundKota) {
    const k = master.kotaMap.find(item => item.kota === foundKota);
    if (k) foundBM = k.bm;
  }
  if (!foundAsm && foundBM && master.asmMap && master.asmMap[foundBM]) {
    foundAsm = master.asmMap[foundBM][0] || '';
  }

  // 4. Clusters for this Kota
  let clusters = [];
  if (foundKota && master.clusterMap) {
    const baseKota = foundKota.replace(/\s+\d+$/, '').trim();
    clusters = master.clusterMap[baseKota] || master.clusterMap[foundKota] || [];
  }

  const selectedCluster = clusters.length > 0 ? randomFrom(clusters) : `Area ${foundKota || 'Umum'}`;

  return {
    ae: aeName,
    asm: foundAsm || '',
    bm: foundBM || '',
    kota: foundKota || '',
    area: foundArea || 'REGULER',
    cluster: selectedCluster,
    clusters: clusters
  };
}

// ── Form Filling & Submission Helper ──
async function fillAndSubmitForm(page, aeItem, cfg, usedPhonesSet, logCallback) {
  // Resolve complete hierarchy
  const hierarchy = resolveAEHierarchy(aeItem, cachedMasterData);
  
  // Find frame with dynamic waiting (up to 30 seconds)
  let frame = null;
  for (let waitFrame = 0; waitFrame < 30; waitFrame++) {
    const frames = page.frames();
    for (const f of frames) {
      if (f.url().includes('googleusercontent.com') && f.url().includes('/blank')) {
        frame = f;
        break;
      }
    }
    if (!frame) {
      for (const f of frames) {
        if (f !== page.mainFrame() && f.url() !== 'about:blank') {
          frame = f;
          break;
        }
      }
    }
    if (frame) break;
    await sleep(1000);
  }
  if (!frame) throw new Error('Tidak dapat menemukan iframe sandbox untuk input data');

  // Wait for dropdownMaster data in the frame
  await frame.waitForFunction(() => {
    return typeof appState !== 'undefined' && appState.dropdownMaster && appState.dropdownMaster.kotaMap;
  }, { timeout: 45000 }).catch(() => {});

  // Generate verified non-empty fields
  const namaCapel = getVerifiedNamaCapel(cfg);
  
  let noHp = generateTrulyRandomPhone(usedPhonesSet);
  usedPhonesSet.add(noHp);
  saveSubmittedPhone(noHp);

  const alamat = generateRandomAlamat(hierarchy.kota);
  const isp = (Array.isArray(cfg.ispList) && cfg.ispList.length > 0) ? randomFrom(cfg.ispList) : randomFrom(['Indihome', 'Biznet', 'Tidak Ada', 'MyRepublic', 'First Media']);
  const statusLead = (Array.isArray(cfg.statusLead) && cfg.statusLead.length > 0) ? randomFrom(cfg.statusLead) : randomFrom(['COOL', 'WARM', 'HOT', 'CLOSING']);
  const cluster = hierarchy.cluster;

  if (logCallback) {
    logCallback(`Mengisi: [${hierarchy.area}] ${hierarchy.kota} | BM: ${hierarchy.bm.replace(/\s+\.$/, '')} | ASM: ${hierarchy.asm.replace(/\s+\.$/, '')} | AE: ${hierarchy.ae} | Capel: ${namaCapel} | No HP: ${noHp}`, 'info');
  }

  // Execute clean form filling & submit inside frame
  await frame.evaluate((data) => {
    // 1. Select area
    if (typeof selectArea === 'function') {
      selectArea(data.area);
    } else {
      appState.selectedArea = data.area;
    }
    if (typeof goToForm === 'function') {
      goToForm();
    }

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

    // Final verification: ensure every single field is non-empty
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

    // Submit form via saveLaporanKunjungan
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
    noHp: noHp,
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

    if (logCallback) logCallback(`Duplikasi nomor ${noHp} terdeteksi di Google Sheet, menghasilkan nomor baru yang benar-benar random (percobaan ${dupAttempt + 1})...`, 'warning');
    await frame.evaluate(() => {
      const btn = document.getElementById('close-dup-popup');
      if (btn) btn.click();
    });
    await sleep(600);
    
    const newHp = generateTrulyRandomPhone(usedPhonesSet);
    usedPhonesSet.add(newHp);
    saveSubmittedPhone(newHp);
    noHp = newHp;
    
    await frame.evaluate((val) => {
      const el = document.getElementById('input-nohp-capel');
      if (el) {
        el.value = val;
        if (typeof validateRealtimeNoHp === 'function') validateRealtimeNoHp();
      }
      if (typeof showLoader === 'function') showLoader('Menyimpan Data', 'Sedang merekam kunjungan prospek...');
      if (typeof saveLaporanKunjungan === 'function') saveLaporanKunjungan();
    }, newHp);
    await sleep(2500);
  }

  // Poll for result dynamically (max 40s)
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

  // Reset form / transition back to start step
  await frame.evaluate(() => {
    try {
      const form = document.getElementById('kunjungan-form');
      if (form) form.reset();
      if (typeof transitionStep === 'function') {
        transitionStep('step-form', 'step-area');
      }
    } catch(e) {}
  }).catch(() => {});

  return { success, toastText: toastText || 'Laporan Sukses!', phone: noHp };
}

// ── Bot Engine ──
async function runBot(cfg) {
  botRunning = true;
  botShouldStop = false;
  activeBrowsers = [];
  sendStatus('running');
  
  const N = cfg.aes.length;
  const totalTarget = cfg.totalSubmissions * N;
  sendLog(`Bot dimulai! Target: ${totalTarget} submission(s) (${cfg.totalSubmissions} per AE x ${N} AE secara paralel)`, 'bot');
  sendLog(`Area: ${cfg.area} | Kota: ${cfg.kota} | ASM: ${cfg.asm}`, 'info');

  const usedPhones = new Set();
  
  let successCount = 0;
  let failCount = 0;
  let processedCount = 0;

  async function worker(workerId, aeItem, targetCount) {
    let localSuccess = 0;
    let localFail = 0;

    const hierarchy = resolveAEHierarchy(aeItem, cachedMasterData);
    const aeName = hierarchy.ae;
    const workerArea = hierarchy.area;
    const workerKota = hierarchy.kota;
    const workerBM = hierarchy.bm;
    const workerAsm = hierarchy.asm;

    function updateWorkerUI(statusText, badgeClass = 'info') {
      broadcast({
        type: 'worker_status',
        workerId,
        aeName,
        statusText,
        currentCount: localSuccess + localFail,
        targetCount,
        successCount: localSuccess,
        failCount: localFail,
        badgeClass
      });
    }

    updateWorkerUI('Meluncurkan browser...', 'info');
    sendLog(`[Bot #${workerId} - AE: ${aeName}] Meluncurkan browser... (${workerKota} | ASM: ${workerAsm.replace(/\s+\.$/, '')})`, 'bot');
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: process.platform === 'linux' ? true : !cfg.showBrowser,
        defaultViewport: { width: 1280, height: 900 },
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
        ],
      });
      activeBrowsers.push(browser);
    } catch (err) {
      sendLog(`[Bot #${workerId} - AE: ${aeName}] Gagal meluncurkan browser: ${err.message}`, 'error');
      updateWorkerUI('Gagal meluncurkan browser', 'error');
      return;
    }

    const page = await browser.newPage();
    try {
      updateWorkerUI('Memuat halaman form...', 'info');
      await page.goto(cfg.formUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(5000);
      updateWorkerUI('Browser siap', 'info');
    } catch(e) {
      updateWorkerUI('Gagal memuat halaman form', 'error');
    }

    for (let i = 1; i <= targetCount; i++) {
      if (botShouldStop) {
        sendLog(`[Bot #${workerId} - AE: ${aeName}] Dihentikan oleh user.`, 'warning');
        updateWorkerUI('Dihentikan', 'error');
        break;
      }

      sendLog(`[Bot #${workerId} - AE: ${aeName}] Memproses Form #${i}/${targetCount}...`, 'info');
      updateWorkerUI(`Mengisi form (${i}/${targetCount})...`, 'running');

      try {
        const result = await fillAndSubmitForm(page, aeItem, cfg, usedPhones, (msg, level) => {
          sendLog(`[Bot #${workerId} - AE: ${aeName}] ${msg}`, level);
        });

        if (result.success) {
          sendLog(`[Bot #${workerId} - AE: ${aeName}] ✅ BERHASIL! Form #${i} tersubmit.`, 'success');
          successCount++;
          localSuccess++;
          saveSubmittedPhone(result.phone);
          updateWorkerUI(`Form #${i} sukses`, 'success');
        } else {
          sendLog(`[Bot #${workerId} - AE: ${aeName}] ❌ GAGAL! Form #${i}: ${result.toastText}`, 'error');
          failCount++;
          localFail++;
          updateWorkerUI(`Form #${i} gagal: ${result.toastText}`, 'error');
        }
      } catch (err) {
        sendLog(`[Bot #${workerId} - AE: ${aeName}] ❌ ERROR Form #${i}: ${err.message}`, 'error');
        failCount++;
        localFail++;
        updateWorkerUI(`Form #${i} error`, 'error');
        try {
          await page.goto(cfg.formUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await sleep(5000);
        } catch(e) {}
      } finally {
        processedCount++;
        sendProgress(processedCount, successCount, failCount);
      }

      if (i < targetCount && !botShouldStop) {
        const delay = randomDelay(cfg.delayMin, cfg.delayMax);
        sendLog(`[Bot #${workerId} - AE: ${aeName}] Menunggu ${(delay / 1000).toFixed(1)} detik...`, 'info');
        updateWorkerUI(`Menunggu ${(delay / 1000).toFixed(1)}s...`, 'wait');
        await sleep(delay);
      }
    }

    try { await page.close(); } catch(e) {}
    try { await browser.close(); } catch (e) {}
    const idx = activeBrowsers.indexOf(browser);
    if (idx > -1) activeBrowsers.splice(idx, 1);
    sendLog(`[Bot #${workerId} - AE: ${aeName}] selesai.`, 'bot');
    updateWorkerUI('Selesai', 'idle');
  }

  // Launch workers with Concurrency Control (Browser Queue)
  const concurrencyLimit = cfg.concurrencyLimit || 5;
  let nextWorkerIndex = 0;
  
  async function runNextWorker() {
    if (nextWorkerIndex >= N) return;
    const w = ++nextWorkerIndex; // 1-based index
    const aeItem = cfg.aes[w - 1];
    const target = cfg.totalSubmissions;
    
    if (target > 0) {
      // Stagger start slightly
      await sleep(1500);
      await worker(w, aeItem, target);
    }
    
    await runNextWorker();
  }
  
  const poolPromises = [];
  for (let i = 0; i < Math.min(concurrencyLimit, N); i++) {
    poolPromises.push(runNextWorker());
    // Stagger initial launches
    await sleep(2500);
  }
  
  await Promise.all(poolPromises);

  sendLog(`═══ SEMUA BOT SELESAI! Berhasil: ${successCount} | Gagal: ${failCount} | Total: ${totalTarget} ═══`, 'success');
  sendResult(successCount, failCount, totalTarget);

  activeBrowsers = [];
  botRunning = false;
  sendStatus('idle');
}

// ── API Routes ──

const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const SCHEDULES_PATH = path.join(__dirname, 'schedules.json');

let schedules = [];

function loadSchedules() {
  if (fs.existsSync(SCHEDULES_PATH)) {
    try {
      schedules = JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8'));
      console.log(`  ✅ [System] Berhasil memuat ${schedules.length} jadwal AE.`);
    } catch(e) {
      console.log('  ⚠ [System] File schedules.json rusak, mengosongkan...');
      schedules = [];
    }
  } else {
    schedules = [];
  }
}

function saveSchedules() {
  try {
    fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(schedules, null, 2));
  } catch (e) {
    console.error('Gagal menulis database jadwal:', e.message);
  }
}

function getGlobalSettings() {
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch (e) {
      console.error('Gagal memuat settings.json, menggunakan default.');
    }
  }
  
  // Fallback to default from config.js or standard values
  return {
    formUrl: config.FORM_URL || FORM_DEFAULT_URL,
    area: config.AREA || 'REGULER',
    totalSubmissions: config.TOTAL_SUBMISSIONS || 5,
    delayMin: config.DELAY_MIN_MS || 3000,
    delayMax: config.DELAY_MAX_MS || 6000,
    concurrencyLimit: 5,
    autoGenerateHP: config.AUTO_GENERATE_HP !== undefined ? config.AUTO_GENERATE_HP : true,
    showBrowser: config.SHOW_BROWSER !== undefined ? config.SHOW_BROWSER : true,
    useDatabaseNames: true,
    namaCapel: config.NAMA_CAPEL || [],
    ispList: config.ISP || ['Indihome', 'Biznet', 'MyRepublic'],
    statusLead: config.STATUS_LEAD || ['COOL', 'WARM', 'HOT', 'CLOSING']
  };
}

function saveGlobalSettings(settings) {
  try {
    const cleanSettings = { ...settings };
    delete cleanSettings.aes;
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(cleanSettings, null, 2));
  } catch (e) {
    console.error('Gagal menulis settings.json:', e.message);
  }
}

const runningScheduleIds = new Set();

async function runScheduledJob(schedule) {
  if (runningScheduleIds.has(schedule.id)) {
    console.log(`[Scheduler] Jadwal untuk AE ${schedule.aeName} sudah sedang berjalan, lewati.`);
    return;
  }
  runningScheduleIds.add(schedule.id);

  const settings = getGlobalSettings();
  const hierarchy = resolveAEHierarchy(schedule, cachedMasterData);
  const aeName = hierarchy.ae;
  const workerKota = hierarchy.kota;
  const workerAsm = hierarchy.asm;
  const targetCount = schedule.totalSubmissions;
  
  console.log(`⏰ [Scheduler] Memulai eksekusi terjadwal untuk AE: ${aeName} (${workerKota})`);
  sendLog(`⏰ [Scheduler] Memulai eksekusi terjadwal untuk AE: ${aeName} (${workerKota} | ${targetCount} submissions)...`, 'system');

  // Update status into live 'Sedang Berjalan'
  schedule.lastRun = {
    time: new Date().toISOString(),
    status: 'Sedang Berjalan',
    progress: `0/${targetCount}`,
    success: 0,
    failed: 0
  };
  broadcast({ type: 'schedules_updated', schedules });

  const usedPhones = new Set();
  let localSuccess = 0;
  let localFail = 0;

  sendLog(`[Jadwal - AE: ${aeName}] Meluncurkan browser... (${workerKota} | ASM: ${workerAsm.replace(/\s+\.$/, '')})`, 'bot');
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true, // Selalu headless untuk schedule background
      defaultViewport: { width: 1280, height: 900 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });
  } catch (err) {
    console.error(`Gagal meluncurkan browser untuk jadwal AE ${aeName}:`, err.message);
    sendLog(`[Jadwal - AE: ${aeName}] ❌ Gagal meluncurkan browser: ${err.message}`, 'error');
    schedule.lastRun = {
      time: new Date().toISOString(),
      status: 'Gagal',
      details: 'Gagal meluncurkan browser: ' + err.message,
      success: 0,
      failed: targetCount
    };
    saveSchedules();
    runningScheduleIds.delete(schedule.id);
    broadcast({ type: 'schedules_updated', schedules });
    return;
  }

  let page;
  try {
    page = await browser.newPage();
    sendLog(`[Jadwal - AE: ${aeName}] Memuat halaman form...`, 'info');
    await page.goto(settings.formUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);

    for (let i = 1; i <= targetCount; i++) {
      schedule.lastRun.progress = `${i}/${targetCount}`;
      schedule.lastRun.success = localSuccess;
      schedule.lastRun.failed = localFail;
      broadcast({ type: 'schedules_updated', schedules });

      sendLog(`[Jadwal - AE: ${aeName}] Memproses Form #${i}/${targetCount}...`, 'info');

      let submissionSuccess = false;
      let lastErrMsg = '';

      // Auto-retry up to 2 attempts per form item if error occurs
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (attempt > 1) {
            sendLog(`[Jadwal - AE: ${aeName}] 🔄 Mencoba ulang Form #${i} (Percobaan ke-${attempt})...`, 'warning');
            await sleep(2500);
          }

          const result = await fillAndSubmitForm(page, schedule, settings, usedPhones, (msg, level) => {
            sendLog(`[Jadwal - AE: ${aeName}] ${msg}`, level);
          });

          if (result.success) {
            sendLog(`[Jadwal - AE: ${aeName}] ✅ BERHASIL! Form #${i} tersubmit.`, 'success');
            localSuccess++;
            saveSubmittedPhone(result.phone);
            submissionSuccess = true;
            break;
          } else {
            lastErrMsg = result.toastText || 'Form submission failed';
            sendLog(`[Jadwal - AE: ${aeName}] ⚠️ Form #${i} percobaan ${attempt} gagal: ${lastErrMsg}`, 'warning');
          }
        } catch (err) {
          lastErrMsg = err.message;
          sendLog(`[Jadwal - AE: ${aeName}] ⚠️ Error Form #${i} percobaan ${attempt}: ${err.message}`, 'warning');
          try {
            await page.goto(settings.formUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await sleep(4000);
          } catch(e) {}
        }
      }

      if (!submissionSuccess) {
        sendLog(`[Jadwal - AE: ${aeName}] ❌ GAGAL Form #${i}: ${lastErrMsg}`, 'error');
        localFail++;
      }

      if (i < targetCount) {
        const delay = randomDelay(settings.delayMin || 3000, settings.delayMax || 6000);
        sendLog(`[Jadwal - AE: ${aeName}] Menunggu ${(delay / 1000).toFixed(1)} detik...`, 'info');
        await sleep(delay);
      }
    }
  } catch (err) {
    console.error(`Fatal error in scheduled job for AE ${aeName}:`, err.message);
    sendLog(`[Jadwal - AE: ${aeName}] ❌ Terjadi kesalahan fatal: ${err.message}`, 'error');
  } finally {
    try { if (page) await page.close(); } catch(e) {}
    try { if (browser) await browser.close(); } catch (e) {}

    runningScheduleIds.delete(schedule.id);

    sendLog(`[Jadwal - AE: ${aeName}] Selesai. Sukses: ${localSuccess} | Gagal: ${localFail}`, localFail === 0 ? 'success' : 'warning');

    schedule.lastRun = {
      time: new Date().toISOString(),
      status: localFail === 0 ? 'Sukses' : (localSuccess > 0 ? 'Sebagian Sukses' : 'Gagal'),
      success: localSuccess,
      failed: localFail,
      details: localFail === 0 ? 'Semua form berhasil disubmit' : `${localFail} dari ${targetCount} form gagal`
    };
    saveSchedules();
    broadcast({ type: 'schedules_updated', schedules });
  }
}

let lastCheckedMinute = '';
function startScheduler() {
  console.log('  ⏰ [Scheduler Engine] Background cron scheduler aktif (Timezone: Asia/Jakarta - WIB).');
  
  setInterval(() => {
    const now = new Date();
    // Accurate WIB time (UTC+7) regardless of whether server runs locally or on UTC VPS
    const wibFormatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const currentMinute = wibFormatter.format(now); // e.g. "08:00", "14:30"
    
    if (currentMinute === lastCheckedMinute) return;
    lastCheckedMinute = currentMinute;
    
    const matchingSchedules = schedules.filter(s => s.active && s.time === currentMinute);
    
    if (matchingSchedules.length > 0) {
      console.log(`⏰ [Scheduler] Menjalankan ${matchingSchedules.length} jadwal pada pukul ${currentMinute} WIB`);
      sendLog(`⏰ [Scheduler] Menjalankan ${matchingSchedules.length} jadwal pada pukul ${currentMinute} WIB...`, 'system');
      
      let delay = 0;
      for (const schedule of matchingSchedules) {
        setTimeout(() => {
          runScheduledJob(schedule).catch(err => {
            console.error(`Error running scheduled job for ${schedule.aeName}:`, err.message);
            sendLog(`⏰ [Scheduler] Error running job for ${schedule.aeName}: ${err.message}`, 'error');
          });
        }, delay);
        delay += 5000; // Stagger initial launch of each scheduled AE by 5 seconds
      }
    }
  }, 10000); // Check every 10 seconds
}

app.get('/api/settings', (req, res) => {
  res.json({ success: true, settings: getGlobalSettings() });
});

app.post('/api/settings', (req, res) => {
  const settings = req.body;
  saveGlobalSettings(settings);
  res.json({ success: true });
});

app.get('/api/schedules', (req, res) => {
  res.json({ success: true, schedules });
});

app.post('/api/schedules', (req, res) => {
  const newSchedules = req.body;
  if (Array.isArray(newSchedules)) {
    schedules = newSchedules;
    saveSchedules();
    broadcast({ type: 'schedules_updated', schedules });
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false, error: 'Format jadwal tidak valid.' });
  }
});

// Run single schedule immediately (manual run / retry)
app.post('/api/schedules/run/:id', async (req, res) => {
  const scheduleId = req.params.id;
  const sched = schedules.find(s => s.id === scheduleId);
  if (!sched) {
    return res.status(404).json({ success: false, error: 'Jadwal tidak ditemukan.' });
  }
  if (runningScheduleIds.has(sched.id)) {
    return res.json({ success: false, error: `Jadwal untuk ${sched.aeName} sedang berjalan!` });
  }

  res.json({ success: true, message: `Memulai eksekusi jadwal untuk AE ${sched.aeName}...` });

  // Run in background asynchronously
  runScheduledJob(sched).catch(err => {
    console.error(`Error manual run schedule for ${sched.aeName}:`, err.message);
    sendLog(`[Manual Run] ❌ Gagal mengeksekusi ${sched.aeName}: ${err.message}`, 'error');
  });
});

// Retry all failed schedules
app.post('/api/schedules/retry-failed', async (req, res) => {
  const failedSchedules = schedules.filter(s => {
    return s.lastRun && (s.lastRun.status === 'Gagal' || s.lastRun.status === 'Sebagian Sukses');
  });

  if (failedSchedules.length === 0) {
    return res.json({ success: false, error: 'Tidak ada jadwal yang berstatus Gagal atau Sebagian Sukses.' });
  }

  res.json({
    success: true,
    message: `Menjalankan ulang ${failedSchedules.length} jadwal yang gagal...`,
    count: failedSchedules.length
  });

  // Run failed schedules sequentially in the background
  (async () => {
    sendLog(`🔄 [Retry Engine] Memulai pengulangan otomatis untuk ${failedSchedules.length} jadwal gagal...`, 'system');
    for (const sched of failedSchedules) {
      if (runningScheduleIds.has(sched.id)) continue;
      try {
        await runScheduledJob(sched);
        await sleep(3000); // Stagger by 3 seconds between runs
      } catch (err) {
        console.error(`Error retrying schedule for ${sched.aeName}:`, err.message);
      }
    }
    sendLog(`🔄 [Retry Engine] Selesai memproses seluruh jadwal ulang.`, 'success');
  })();
});

app.post('/api/verify-pin', (req, res) => {
  const { pin } = req.body;
  const expectedPin = config.BOT_PIN || '1234';
  if (pin === expectedPin) {
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, error: 'PIN salah!' });
});

app.post('/api/start', (req, res) => {
  if (botRunning) {
    return res.json({ success: false, error: 'Bot sudah berjalan!' });
  }
  const cfg = req.body;
  
  // Save settings automatically on start
  saveGlobalSettings(cfg);
  
  res.json({ success: true });
  // Run bot async
  runBot(cfg).catch(err => {
    sendLog('Fatal error: ' + err.message, 'error');
    sendStatus('error');
    botRunning = false;
  });
});

app.post('/api/stop', async (req, res) => {
  botShouldStop = true;
  for (const b of activeBrowsers) {
    try { await b.close(); } catch (e) { /* ignore */ }
  }
  activeBrowsers = [];
  botRunning = false;
  sendStatus('idle');
  sendLog('Semua bot dihentikan.', 'warning');
  res.json({ success: true });
});

app.get('/api/status', (req, res) => {
  res.json({ running: botRunning });
});

app.get('/api/master-data', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';
  const targetUrl = req.query.url || FORM_DEFAULT_URL;

  if (cachedMasterData && !forceRefresh) {
    return res.json({ success: true, data: cachedMasterData });
  }
  // Reuse existing promise or start new one
  if (!masterDataPromise) {
    masterDataPromise = getMasterDataFromForm(targetUrl).then(data => {
      if (data) cachedMasterData = data;
      masterDataPromise = null;
      return data;
    });
  }
  
  const data = await masterDataPromise;
  if (data) {
    return res.json({ success: true, data });
  }
  res.json({ success: false, error: 'Gagal mengambil data master dari Google Sheets. Coba muat ulang halaman beberapa saat lagi.' });
});

// ── System Health & Maintenance APIs ──
app.get('/api/system/status', (req, res) => {
  try {
    const uptimeSec = Math.floor((Date.now() - serverStartTime) / 1000);
    const sysUptimeSec = Math.floor(os.uptime());

    const formatUptime = (seconds) => {
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;
      const parts = [];
      if (days > 0) parts.push(`${days}h`);
      if (hours > 0 || days > 0) parts.push(`${hours}j`);
      if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
      parts.push(`${secs}d`);
      return parts.join(' ');
    };

    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    res.json({
      success: true,
      data: {
        uptime: {
          processSeconds: uptimeSec,
          processFormatted: formatUptime(uptimeSec),
          systemSeconds: sysUptimeSec,
          systemFormatted: formatUptime(sysUptimeSec),
          startedAt: new Date(serverStartTime).toISOString()
        },
        memory: {
          nodeHeapUsedMB: (memUsage.heapUsed / 1024 / 1024).toFixed(1),
          nodeHeapTotalMB: (memUsage.heapTotal / 1024 / 1024).toFixed(1),
          nodeRssMB: (memUsage.rss / 1024 / 1024).toFixed(1),
          systemTotalMB: (totalMem / 1024 / 1024).toFixed(0),
          systemUsedMB: (usedMem / 1024 / 1024).toFixed(0),
          systemFreeMB: (freeMem / 1024 / 1024).toFixed(0),
          systemUsedPercent: Math.round((usedMem / totalMem) * 100)
        },
        cpu: {
          cores: os.cpus().length,
          model: os.cpus()[0]?.model || 'Generic CPU',
          loadAvg: os.loadavg ? os.loadavg().map(v => Number(v.toFixed(2))) : [0, 0, 0]
        },
        system: {
          platform: os.platform(),
          arch: os.arch(),
          nodeVersion: process.version,
          osRelease: os.release()
        },
        database: {
          totalSubmittedPhones: submittedPhones ? submittedPhones.size : 0,
          totalSchedules: schedules ? schedules.length : 0,
          activeSchedules: schedules ? schedules.filter(s => s.active).length : 0,
          masterDataCached: !!cachedMasterData
        },
        bot: {
          isRunning: botRunning,
          activeBrowsers: activeBrowsers.length
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/system/restart', async (req, res) => {
  try {
    sendLog('⚠️ Permintaan restart server diterima. Memulai ulang proses bot server...', 'warning');

    // Close any active browsers safely
    botShouldStop = true;
    for (const b of activeBrowsers) {
      try { await b.close(); } catch (e) {}
    }
    activeBrowsers = [];
    botRunning = false;

    res.json({ success: true, message: 'Server sedang memulai ulang...' });

    // Graceful restart: Exit process after short delay so HTTP response completes
    // When running under PM2 on VPS, PM2 will instantly restart the process
    setTimeout(() => {
      console.log('🔄 [System] Restarting server process via PM2 / process.exit(0)...');
      process.exit(0);
    }, 800);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/system/cleanup', (req, res) => {
  try {
    cachedMasterData = null;
    if (global.gc) {
      global.gc();
    }
    sendLog('🧹 [System] Cache internal master data dan memori berhasil dibersihkan.', 'system');
    res.json({ success: true, message: 'Cache dan memori berhasil dibersihkan.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Start Server ──
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════╗');
  console.log('  ║   🤖  BOT DASHBOARD - DATA LEAD AE           ║');
  console.log('  ╠═══════════════════════════════════════════════╣');
  console.log(`  ║   🌐  http://localhost:${PORT}                   ║`);
  console.log('  ║   📋  Buka URL di atas di browser Anda        ║');
  console.log('  ╚═══════════════════════════════════════════════╝');
  console.log('');

  // Load master data from file or fetch if not exists
  if (fs.existsSync(MASTER_DATA_PATH)) {
    try {
      cachedMasterData = JSON.parse(fs.readFileSync(MASTER_DATA_PATH, 'utf8'));
      console.log('  ✅ [System] Master data wilayah berhasil dimuat secara instan dari lokal!');
    } catch(e) {
      console.log('  ⚠ [System] File master_data.json rusak, mengambil ulang...');
    }
  }

  if (!cachedMasterData && !masterDataPromise) {
    masterDataPromise = getMasterDataFromForm(FORM_DEFAULT_URL).then(data => {
      if (data) {
        cachedMasterData = data;
        console.log('  ✅ [System] Master data wilayah berhasil disinkronisasi & dicache!');
      }
      masterDataPromise = null;
      return data;
    });
  }

  // Load schedules from file
  loadSchedules();
  // Start background cron scheduler
  startScheduler();
});
