/**
 * ============================================================
 *  SERVER DASHBOARD + BOT ENGINE
 *  Express + WebSocket + Puppeteer
 * ============================================================
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const puppeteer = require('puppeteer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = 3005;

// ── Middleware ──
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database Names ──
const databaseNames = require('./public/names.json');

// ── Master Dropdowns Cache & Extractor ──
let cachedMasterData = null;
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
    await sleep(6000);
    
    // Find the correct frame whose url contains "/blank"
    const frames = page.frames();
    let frame = null;
    for (const f of frames) {
      if (f.url().includes('googleusercontent.com') && f.url().includes('/blank')) {
        frame = f;
        break;
      }
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
    
    // Wait for spreadsheet dropdown data fetch
    await sleep(8000);
    
    const masterData = await frame.evaluate(() => {
      if (typeof appState !== 'undefined' && appState.dropdownMaster) {
        return {
          kotaMap: appState.dropdownMaster.kotaMap || [],
          asmMap: appState.dropdownMaster.asmMap || {},
          aeMap: appState.dropdownMaster.aeMap || {}
        };
      }
      return null;
    });
    
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
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateRandomPhone() {
  let phone = '08';
  const len = randomDelay(8, 11);
  for (let i = 0; i < len; i++) phone += Math.floor(Math.random() * 10);
  return phone;
}

function generateRandomAlamat() {
  const streets = ['Merpati', 'Kenari', 'Anggrek', 'Mawar', 'Dahlia', 'Melati', 'Flamboyan', 'Teratai', 'Bougenville', 'Kamboja', 'Cempaka', 'Kecubung', 'Pahlawan', 'Sudirman', 'Gatot Subroto', 'Diponegoro', 'Ahmad Yani', 'Pemuda', 'Pandanaran', 'Siliwangi'];
  const prefixes = ['Jl.', 'Jalan', 'Gang'];
  const blocks = ['Blok A', 'Blok B', 'Blok C', 'Blok D', 'Blok E', 'No.'];
  
  const street = randomFrom(streets);
  const prefix = randomFrom(prefixes);
  const block = randomFrom(blocks);
  const num = randomDelay(1, 120);
  const rt = randomDelay(1, 12);
  const rw = randomDelay(1, 10);
  
  const blockStr = block === 'No.' ? ` No. ${num}` : ` ${block} No. ${randomDelay(1, 30)}`;
  return `${prefix} ${street}${blockStr}, RT 0${rt}/RW 0${rw}, Jawa Tengah`;
}


// ── Bot Engine ──
async function runBot(cfg) {
  botRunning = true;
  botShouldStop = false;
  activeBrowsers = [];
  sendStatus('running');
  
  const N = cfg.aes.length;
  sendLog(`Bot dimulai! Target: ${cfg.totalSubmissions} submission(s) (${N} AE secara paralel)`, 'bot');
  sendLog(`Area: ${cfg.area} | Kota: ${cfg.kota} | ASM: ${cfg.asm}`, 'info');

  const usedPhones = new Set();
  
  let successCount = 0;
  let failCount = 0;
  let processedCount = 0;

  async function worker(workerId, aeName, targetCount) {
    let workerAsm = cfg.asm;
    if (cachedMasterData && cachedMasterData.aeMap) {
      for (const [asmName, aeList] of Object.entries(cachedMasterData.aeMap)) {
        if (aeList.includes(aeName)) {
          workerAsm = asmName;
          break;
        }
      }
    }
    sendLog(`[Bot #${workerId} - AE: ${aeName}] Meluncurkan browser... (ASM: ${workerAsm})`, 'bot');
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: !cfg.showBrowser,
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
      return;
    }

    for (let i = 1; i <= targetCount; i++) {
      if (botShouldStop) {
        sendLog(`[Bot #${workerId} - AE: ${aeName}] Dihentikan oleh user.`, 'warning');
        break;
      }

      sendLog(`[Bot #${workerId} - AE: ${aeName}] Memproses Form #${i}/${targetCount}...`, 'info');
      const page = await browser.newPage();

      try {
        // Navigate
        await page.goto(cfg.formUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(5000);

        // Find frame
        let frame = null;
        const frames = page.frames();
        for (const f of frames) {
          if (f.url().includes('googleusercontent.com') && f.url().includes('/blank')) {
            frame = f;
            break;
          }
        }
        if (!frame) {
          for (const f of frames) {
            if (f !== page.mainFrame()) { frame = f; break; }
          }
        }
        if (!frame) throw new Error('Tidak dapat menemukan iframe sandbox untuk input data');

        // Wait for content
        for (let attempt = 0; attempt < 20; attempt++) {
          try {
            const ok = await frame.evaluate(() => {
              const s = document.getElementById('step-area');
              if (s && !s.classList.contains('hidden')) return true;
              if (document.querySelectorAll('[onclick*="selectArea"]').length > 0) return true;
              return document.body && document.body.innerText.length > 100;
            });
            if (ok) break;
          } catch (e) { /* retry */ }
          await sleep(1500);
        }

        // Wait for dropdowns fetch
        await sleep(8000);
        if (botShouldStop) { await page.close(); break; }

        // Select Area
        const areaSelector = cfg.area === 'REGULER' ? '[onclick*="REGULER"]' : '[onclick*="RING"]';
        await frame.waitForSelector(areaSelector, { timeout: 15000 });
        
        await frame.evaluate((selector) => {
          const el = document.querySelector(selector);
          if (el) el.click();
        }, areaSelector);
        await sleep(2500);

        // Strategy page
        const strategySelector = '[onclick*="goToForm"]';
        try {
          await frame.waitForSelector(strategySelector, { timeout: 10000 });
          await frame.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (el) el.click();
          }, strategySelector);
        } catch (e) {
          await frame.evaluate(() => {
            if (typeof goToForm === 'function') goToForm();
          });
        }
        await sleep(2500);

        // Fill form
        // ── Setting Kota ──
        const kotaSet = await frame.evaluate((kotaValue) => {
          const sel = document.getElementById('input-kota');
          if (!sel) return false;
          for (const opt of sel.options) {
            if (opt.value.toUpperCase() === kotaValue.toUpperCase() || opt.text.toUpperCase() === kotaValue.toUpperCase()) {
              sel.value = opt.value;
              sel.dispatchEvent(new Event('change'));
              if (typeof onKotaChanged === 'function') onKotaChanged();
              return true;
            }
          }
          const available = Array.from(sel.options).filter(o => !o.disabled && o.value);
          if (available.length > 0) {
            sel.value = available[0].value;
            sel.dispatchEvent(new Event('change'));
            if (typeof onKotaChanged === 'function') onKotaChanged();
            return true;
          }
          return false;
        }, cfg.kota);
        await sleep(2000);

        // Set BM
        if (cfg.bm) {
          await frame.evaluate((v) => {
            const el = document.getElementById('input-bm');
            if (el) { el.value = v; el.readOnly = false; }
          }, cfg.bm);
        }

        // Set ASM
        await frame.evaluate((asmValue) => {
          const sel = document.getElementById('input-asm');
          if (!sel) return false;
          sel.disabled = false;
          for (const opt of sel.options) {
            if (opt.value.toUpperCase() === asmValue.toUpperCase() || opt.text.toUpperCase() === asmValue.toUpperCase()) {
              sel.value = opt.value;
              sel.dispatchEvent(new Event('change'));
              if (typeof onAsmChanged === 'function') onAsmChanged();
              return true;
            }
          }
          const available = Array.from(sel.options).filter(o => !o.disabled && o.value);
          if (available.length > 0) {
            sel.value = available[0].value;
            sel.dispatchEvent(new Event('change'));
            if (typeof onAsmChanged === 'function') onAsmChanged();
            return true;
          }
          return false;
        }, workerAsm);
        await sleep(1500);

        // Set AE (DEDICATED)
        await frame.evaluate((aeValue) => {
          const sel = document.getElementById('input-ae');
          if (!sel) return false;
          sel.disabled = false;
          for (const opt of sel.options) {
            if (opt.value.toUpperCase() === aeValue.toUpperCase() || opt.text.toUpperCase() === aeValue.toUpperCase()) {
              sel.value = opt.value;
              sel.dispatchEvent(new Event('change'));
              return true;
            }
          }
          const available = Array.from(sel.options).filter(o => !o.disabled && o.value);
          if (available.length > 0) {
            sel.value = available[0].value;
            sel.dispatchEvent(new Event('change'));
            return true;
          }
          return false;
        }, aeName);
        await sleep(1000);

        // Set Cluster (Randomly from dropdown options)
        await frame.evaluate(() => {
          const searchInput = document.getElementById('cluster-search');
          if (searchInput) searchInput.disabled = false;
          if (typeof openClusterDropdown === 'function') openClusterDropdown();
        });
        await sleep(2000);

        const selectedCluster = await frame.evaluate(() => {
          const options = document.querySelectorAll('#cluster-options > button');
          if (options.length > 0) {
            const idx = Math.floor(Math.random() * options.length);
            const opt = options[idx];
            opt.click();
            return opt.textContent.trim();
          }
          return null;
        });

        if (!selectedCluster) {
          const fallbackCluster = 'Cluster Reguler';
          await frame.evaluate((fallback) => {
            const list = document.getElementById('cluster-dropdown-list');
            if (list) list.classList.add('hidden');
            document.getElementById('input-cluster').value = fallback;
            document.getElementById('cluster-search').value = fallback;
          }, fallbackCluster);
        }
        await sleep(1000);

        // Nama Capel
        const namaCapel = cfg.useDatabaseNames ? randomFrom(databaseNames) : randomFrom(cfg.namaCapel);
        await frame.evaluate((v) => { document.getElementById('input-nama-capel').value = v; }, namaCapel);

        // No HP
        let noHp;
        if (cfg.autoGenerateHP) {
          do { noHp = generateRandomPhone(); } while (usedPhones.has(noHp));
        } else {
          noHp = generateRandomPhone();
        }
        usedPhones.add(noHp);

        await frame.evaluate(() => { document.getElementById('input-nohp-capel').value = ''; });
        await frame.click('#input-nohp-capel');
        await frame.type('#input-nohp-capel', noHp, { delay: 20 });
        await sleep(2000);

        // Check duplicate popup
        const isDuplicate = await frame.evaluate(() => {
          const popup = document.getElementById('duplicate-popup');
          return popup && !popup.classList.contains('hidden');
        });
        if (isDuplicate) {
          await frame.evaluate(() => { document.getElementById('close-dup-popup').click(); });
          await sleep(500);
          const newHp = generateRandomPhone();
          usedPhones.add(newHp);
          await frame.evaluate(() => { document.getElementById('input-nohp-capel').value = ''; });
          await frame.type('#input-nohp-capel', newHp, { delay: 20 });
          await sleep(1500);
        }

        // Alamat (Randomly generated)
        const alamat = generateRandomAlamat();
        await frame.evaluate((v) => { document.getElementById('input-alamat').value = v; }, alamat);

        // ISP
        const isp = randomFrom(cfg.ispList);
        await frame.evaluate((v) => { document.getElementById('input-isp').value = v; }, isp);

        // Status Lead
        const statusLead = randomFrom(cfg.statusLead);
        await frame.select('#input-status-lead', statusLead);
        await sleep(1000);

        // Submit
        await frame.evaluate(() => {
          const form = document.getElementById('kunjungan-form');
          if (form) {
            const ev = new Event('submit', { cancelable: true, bubbles: true });
            form.dispatchEvent(ev);
          }
          if (typeof handleFormSubmit === 'function') {
            handleFormSubmit(new Event('submit', { cancelable: true }));
          }
        });

        await sleep(8000);

        // Check result
        const toastText = await frame.evaluate(() => {
          const el = document.getElementById('toast-title');
          return el ? el.innerText : '';
        }).catch(() => '');

        if (toastText.toLowerCase().includes('sukses') || toastText.toLowerCase().includes('berhasil')) {
          sendLog(`[Bot #${workerId} - AE: ${aeName}] ✅ BERHASIL! Form #${i} tersubmit.`, 'success');
          successCount++;
        } else if (toastText.toLowerCase().includes('error') || toastText.toLowerCase().includes('gagal')) {
          sendLog(`[Bot #${workerId} - AE: ${aeName}] ❌ GAGAL! Form #${i}: ${toastText}`, 'error');
          failCount++;
        } else {
          sendLog(`[Bot #${workerId} - AE: ${aeName}] Form #${i} terkirim (toast: "${toastText || 'none'}")`, 'warning');
          successCount++;
        }

      } catch (err) {
        sendLog(`[Bot #${workerId} - AE: ${aeName}] ❌ ERROR Form #${i}: ${err.message}`, 'error');
        failCount++;
      } finally {
        processedCount++;
        await page.close();
        sendProgress(processedCount, successCount, failCount);
      }

      if (i < targetCount && !botShouldStop) {
        const delay = randomDelay(cfg.delayMin, cfg.delayMax);
        sendLog(`[Bot #${workerId} - AE: ${aeName}] Menunggu ${(delay / 1000).toFixed(1)} detik...`, 'info');
        await sleep(delay);
      }
    }

    try { await browser.close(); } catch (e) {}
    const idx = activeBrowsers.indexOf(browser);
    if (idx > -1) activeBrowsers.splice(idx, 1);
    sendLog(`[Bot #${workerId} - AE: ${aeName}] selesai.`, 'bot');
  }

  // Launch workers in parallel, each dedicated to a selected AE
  const workerPromises = [];
  for (let w = 1; w <= N; w++) {
    const aeName = cfg.aes[w - 1];
    const target = Math.floor(cfg.totalSubmissions / N) + (w <= cfg.totalSubmissions % N ? 1 : 0);
    
    if (target > 0) {
      workerPromises.push(worker(w, aeName, target));
      // Stagger start by 2.5 seconds
      await sleep(2500);
    }
  }

  await Promise.all(workerPromises);

  sendLog(`═══ SEMUA BOT SELESAI! Berhasil: ${successCount} | Gagal: ${failCount} | Total: ${cfg.totalSubmissions} ═══`, 'success');
  sendResult(successCount, failCount, cfg.totalSubmissions);

  activeBrowsers = [];
  botRunning = false;
  sendStatus('idle');
}

// ── API Routes ──

app.post('/api/start', (req, res) => {
  if (botRunning) {
    return res.json({ success: false, error: 'Bot sudah berjalan!' });
  }
  const cfg = req.body;
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
  if (cachedMasterData) {
    return res.json({ success: true, data: cachedMasterData });
  }
  // Try fetching on demand
  const data = await getMasterDataFromForm(FORM_DEFAULT_URL);
  if (data) {
    cachedMasterData = data;
    return res.json({ success: true, data });
  }
  res.json({ success: false, error: 'Gagal mengambil data master dari Google Sheets. Coba muat ulang halaman beberapa saat lagi.' });
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

  // Start background fetch
  getMasterDataFromForm(FORM_DEFAULT_URL).then(data => {
    if (data) {
      cachedMasterData = data;
      console.log('  ✅ [System] Master data wilayah berhasil dicache!');
    }
  });
});
