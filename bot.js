/**
 * ============================================================
 *  BOT PENGISI FORM OTOMATIS v2
 *  Report Data Lead AE - MoraRepublic Jawa Tengah Utara
 * ============================================================
 * 
 *  Pendekatan: Navigasi langsung ke sandbox iframe URL
 *  untuk menghindari masalah cross-origin iframe access.
 * 
 *  Cara pakai:
 *    1. Edit config.js sesuai kebutuhan
 *    2. npm install
 *    3. npm start
 * ============================================================
 */

const puppeteer = require('puppeteer');
const config = require('./config');

// ── Utility Functions ───────────────────────────────────────

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
  const prefix = '08';
  let phone = prefix;
  const extraDigits = randomDelay(8, 11);
  for (let i = 0; i < extraDigits; i++) {
    phone += Math.floor(Math.random() * 10);
  }
  return phone;
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

// ── Extract sandbox URL from parent page ────────────────────

async function extractSandboxUrl(page) {
  log('Mengekstrak sandbox URL dari parent page...', 'wait');
  await page.goto(config.FORM_URL, {
    waitUntil: 'networkidle2',
    timeout: 60000,
  });
  await sleep(2000);

  // Extract the sandbox URL from the page's script init data
  const sandboxUrl = await page.evaluate(() => {
    const iframe = document.getElementById('sandboxFrame');
    if (iframe && iframe.src) return iframe.src;
    
    // Try to extract from page scripts
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      const match = text.match(/sandboxHost['":\s]+["']([^"']+)['"]/);
      if (match) return match[1];
    }
    return null;
  });

  return sandboxUrl;
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
  log(`Area: ${config.AREA}`, 'info');
  log(`Browser: ${config.SHOW_BROWSER ? 'Visible' : 'Headless'}`, 'info');
  log(`Auto-generate HP: ${config.AUTO_GENERATE_HP ? 'Ya' : 'Tidak'}`, 'info');
  console.log('  ─────────────────────────────────────────────────');
  console.log('');

  log('Meluncurkan browser...', 'bot');
  const browser = await puppeteer.launch({
    headless: !config.SHOW_BROWSER,
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

  for (let i = 1; i <= config.TOTAL_SUBMISSIONS; i++) {
    console.log(`  ┌─── Submission ${i}/${config.TOTAL_SUBMISSIONS} ───────────────────────`);

    const page = await browser.newPage();

    try {
      // ── Step 1: Navigate to form ──
      log('Membuka halaman form...', 'wait');
      await page.goto(config.FORM_URL, {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });

      // Wait for iframe to be available, then access it
      log('Menunggu iframe sandbox...', 'wait');
      await sleep(5000);

      // Try to get the iframe frame from the page
      let frame = null;
      
      // Method 1: Try getting frame from all frames
      const frames = page.frames();
      for (const f of frames) {
        if (f !== page.mainFrame()) {
          frame = f;
          break;
        }
      }

      // Method 2: If no frame found, try via element handle
      if (!frame) {
        try {
          const iframeHandle = await page.waitForSelector('#sandboxFrame', { timeout: 10000 });
          frame = await iframeHandle.contentFrame();
        } catch (e) {
          // continue
        }
      }

      // Method 3: Wait a bit more and try again
      if (!frame) {
        log('Frame belum tersedia, menunggu lebih lama...', 'wait');
        await sleep(5000);
        const frames2 = page.frames();
        for (const f of frames2) {
          if (f !== page.mainFrame()) {
            frame = f;
            break;
          }
        }
      }

      if (!frame) {
        throw new Error('Tidak dapat mengakses iframe sandbox. Coba jalankan ulang.');
      }

      log('Iframe berhasil diakses!', 'success');

      // Wait for the app content to load inside the frame
      // Instead of checking for loader, wait for the area selection buttons
      log('Menunggu konten form dimuat...', 'wait');

      // Wait for specific content to appear - try multiple selectors
      let contentLoaded = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const hasContent = await frame.evaluate(() => {
            // Check if area selection section is visible
            const stepArea = document.getElementById('step-area');
            if (stepArea && !stepArea.classList.contains('hidden')) return true;
            // Check if any grid/card is visible
            const cards = document.querySelectorAll('[onclick*="selectArea"]');
            if (cards.length > 0) return true;
            // Check if the body has meaningful content
            if (document.body && document.body.innerText.length > 100) return true;
            return false;
          });
          if (hasContent) {
            contentLoaded = true;
            break;
          }
        } catch (e) {
          // Frame might not be ready yet
        }
        await sleep(1500);
      }

      if (!contentLoaded) {
        // Last resort: just wait and proceed
        log('Konten belum terdeteksi, tetap lanjut...', 'warning');
        await sleep(5000);
      } else {
        log('Konten form berhasil dimuat!', 'success');
      }

      // Also wait for google.script.run to be ready (data fetch)
      log('Menunggu data dropdown dari server...', 'wait');
      await sleep(8000); // Give time for getAreaMasterData + getDropdownData

      // ── Step 2: Select Area ──
      log(`Memilih area: ${config.AREA}`, 'form');
      try {
        if (config.AREA === 'REGULER') {
          await frame.evaluate(() => { selectArea('REGULER'); });
        } else {
          await frame.evaluate(() => { selectArea('RING & ECO'); });
        }
      } catch (e) {
        // Try clicking the button directly
        log('Mencoba klik tombol area secara langsung...', 'warning');
        if (config.AREA === 'REGULER') {
          await frame.click('[onclick*="REGULER"]');
        } else {
          await frame.click('[onclick*="RING"]');
        }
      }
      await sleep(2000);

      // ── Step 3: Strategy page - Click "Lanjutkan Mengisi Form" ──
      log('Melewati halaman strategi...', 'form');
      try {
        await frame.evaluate(() => { goToForm(); });
      } catch (e) {
        await frame.click('button[onclick*="goToForm"]');
      }
      await sleep(2000);

      // ── Step 4: Fill the form ──
      log('Mengisi form kunjungan...', 'form');

      // 4a. Select Kota
      log('  ↳ Memilih Kota...', 'info');
      
      // Wait for kota options to be populated
      let kotaReady = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        const optCount = await frame.evaluate(() => {
          const sel = document.getElementById('input-kota');
          if (!sel) return 0;
          return Array.from(sel.options).filter(o => !o.disabled && o.value).length;
        });
        if (optCount > 0) { kotaReady = true; break; }
        await sleep(1000);
      }

      if (!kotaReady) {
        throw new Error('Dropdown Kota tidak memiliki opsi. Data mungkin gagal dimuat.');
      }

      const kotaOptions = await frame.evaluate(() => {
        const sel = document.getElementById('input-kota');
        return Array.from(sel.options).filter(o => !o.disabled && o.value).map(o => o.value);
      });
      const selectedKota = randomFrom(kotaOptions);
      
      await frame.select('#input-kota', selectedKota);
      await frame.evaluate(() => { onKotaChanged(); });
      log(`  ↳ Kota: ${selectedKota}`, 'info');
      await sleep(2000);

      // 4b. Select ASM
      log('  ↳ Memilih ASM...', 'info');
      for (let attempt = 0; attempt < 10; attempt++) {
        const ready = await frame.evaluate(() => {
          const sel = document.getElementById('input-asm');
          return sel && !sel.disabled && Array.from(sel.options).filter(o => !o.disabled && o.value).length > 0;
        });
        if (ready) break;
        await sleep(1000);
      }

      const asmOptions = await frame.evaluate(() => {
        const sel = document.getElementById('input-asm');
        return Array.from(sel.options).filter(o => !o.disabled && o.value).map(o => o.value);
      });
      if (asmOptions.length === 0) throw new Error('Tidak ada opsi ASM tersedia');
      
      const selectedAsm = randomFrom(asmOptions);
      await frame.select('#input-asm', selectedAsm);
      await frame.evaluate(() => { onAsmChanged(); });
      log(`  ↳ ASM: ${selectedAsm}`, 'info');
      await sleep(1500);

      // 4c. Select AE
      log('  ↳ Memilih AE...', 'info');
      for (let attempt = 0; attempt < 10; attempt++) {
        const ready = await frame.evaluate(() => {
          const sel = document.getElementById('input-ae');
          return sel && !sel.disabled && Array.from(sel.options).filter(o => !o.disabled && o.value).length > 0;
        });
        if (ready) break;
        await sleep(1000);
      }

      const aeOptions = await frame.evaluate(() => {
        const sel = document.getElementById('input-ae');
        return Array.from(sel.options).filter(o => !o.disabled && o.value).map(o => o.value);
      });
      if (aeOptions.length === 0) throw new Error('Tidak ada opsi AE tersedia');
      
      const selectedAe = randomFrom(aeOptions);
      await frame.select('#input-ae', selectedAe);
      log(`  ↳ AE: ${selectedAe}`, 'info');
      await sleep(1000);

      // 4d. Select Cluster
      log('  ↳ Memilih Nama Cluster...', 'info');
      // Wait for cluster search to be enabled
      for (let attempt = 0; attempt < 10; attempt++) {
        const ready = await frame.evaluate(() => {
          const input = document.getElementById('cluster-search');
          return input && !input.disabled;
        });
        if (ready) break;
        await sleep(1000);
      }

      await frame.evaluate(() => { openClusterDropdown(); });
      await sleep(1000);

      const clusterSelected = await frame.evaluate(() => {
        const options = document.querySelectorAll('#cluster-options > button');
        if (options.length > 0) {
          const idx = Math.floor(Math.random() * options.length);
          options[idx].click();
          return document.getElementById('input-cluster').value || 'selected';
        }
        return null;
      });

      if (clusterSelected) {
        log(`  ↳ Cluster: ${clusterSelected}`, 'info');
      } else {
        await frame.type('#cluster-search', 'Area Umum');
        await frame.evaluate(() => { document.getElementById('input-cluster').value = 'Area Umum'; });
        log('  ↳ Cluster: Area Umum (manual)', 'info');
      }
      await sleep(500);

      // 4e. Nama Capel
      const namaCapel = randomFrom(config.NAMA_CAPEL);
      await frame.evaluate((v) => { document.getElementById('input-nama-capel').value = v; }, namaCapel);
      log(`  ↳ Nama Capel: ${namaCapel}`, 'info');

      // 4f. No HP Capel
      let noHp;
      if (config.AUTO_GENERATE_HP) {
        do { noHp = generateRandomPhone(); } while (usedPhones.has(noHp));
      } else {
        const available = config.NO_HP_CAPEL.filter(p => !usedPhones.has(p));
        if (available.length === 0) {
          do { noHp = generateRandomPhone(); } while (usedPhones.has(noHp));
        } else {
          noHp = randomFrom(available);
        }
      }
      usedPhones.add(noHp);

      // Clear and type HP
      await frame.evaluate(() => { document.getElementById('input-nohp-capel').value = ''; });
      await frame.click('#input-nohp-capel');
      await frame.type('#input-nohp-capel', noHp, { delay: 20 });
      log(`  ↳ No HP: ${noHp}`, 'info');
      await sleep(2000);

      // Check for duplicate popup
      const isDuplicate = await frame.evaluate(() => {
        const popup = document.getElementById('duplicate-popup');
        return popup && !popup.classList.contains('hidden');
      });

      if (isDuplicate) {
        log('Duplikat terdeteksi! Mencoba nomor lain...', 'warning');
        await frame.evaluate(() => { document.getElementById('close-dup-popup').click(); });
        await sleep(500);
        const newHp = generateRandomPhone();
        usedPhones.add(newHp);
        await frame.evaluate(() => { document.getElementById('input-nohp-capel').value = ''; });
        await frame.type('#input-nohp-capel', newHp, { delay: 20 });
        log(`  ↳ No HP (retry): ${newHp}`, 'info');
        await sleep(1500);
      }

      // 4g. Alamat
      const alamat = randomFrom(config.ALAMAT_CAPEL);
      await frame.evaluate((v) => { document.getElementById('input-alamat').value = v; }, alamat);
      log(`  ↳ Alamat: ${alamat.substring(0, 45)}...`, 'info');

      // 4h. ISP
      const isp = randomFrom(config.ISP);
      await frame.evaluate((v) => { document.getElementById('input-isp').value = v; }, isp);
      log(`  ↳ ISP: ${isp}`, 'info');

      // 4i. Status Lead
      const statusLead = randomFrom(config.STATUS_LEAD);
      await frame.select('#input-status-lead', statusLead);
      log(`  ↳ Status Lead: ${statusLead}`, 'info');

      await sleep(1000);

      // ── Step 5: Submit ──
      log('Mengirim form...', 'rocket');
      await frame.evaluate(() => {
        const form = document.getElementById('kunjungan-form');
        if (form) {
          const event = new Event('submit', { cancelable: true, bubbles: true });
          form.dispatchEvent(event);
        }
        // Also try calling the handler directly
        if (typeof handleFormSubmit === 'function') {
          handleFormSubmit(new Event('submit', { cancelable: true }));
        }
      });

      // Wait for response
      log('Menunggu respons server...', 'wait');
      await sleep(8000);

      // Check toast
      const toastText = await frame.evaluate(() => {
        const el = document.getElementById('toast-title');
        return el ? el.innerText : '';
      }).catch(() => '');

      if (toastText.toLowerCase().includes('sukses') || toastText.toLowerCase().includes('berhasil')) {
        log(`BERHASIL! Form #${i} tersubmit.`, 'success');
        successCount++;
      } else if (toastText.toLowerCase().includes('error') || toastText.toLowerCase().includes('gagal')) {
        log(`GAGAL! Form #${i}: ${toastText}`, 'error');
        failCount++;
      } else {
        log(`Form #${i} terkirim (toast: "${toastText || 'none'}")`, 'warning');
        successCount++;
      }

    } catch (err) {
      log(`ERROR pada submission #${i}: ${err.message}`, 'error');
      failCount++;
    } finally {
      await page.close();
    }

    console.log(`  └────────────────────────────────────────────────`);

    if (i < config.TOTAL_SUBMISSIONS) {
      const delay = randomDelay(config.DELAY_MIN_MS, config.DELAY_MAX_MS);
      log(`Menunggu ${(delay / 1000).toFixed(1)} detik...`, 'wait');
      await sleep(delay);
    }
    console.log('');
  }

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
