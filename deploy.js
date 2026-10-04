const { Client } = require('ssh2');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const os = require('os');

const CONFIG = {
  host: '159.65.142.167',
  port: 22,
  username: 'root',
  password: 'asd8418427',
  passphrase: 'asd8418427',
  privateKeyPath: path.join(os.homedir(), '.ssh', 'id_ed25519'),
  remotePath: '/root/form-bot',
  archiveName: 'project.tar.gz'
};

function runLocal(command) {
  return new Promise((resolve, reject) => {
    console.log(`[Local] Running: ${command}`);
    exec(command, (err, stdout, stderr) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function connectSSH() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    
    const connOptions = {
      host: CONFIG.host,
      port: CONFIG.port,
      username: CONFIG.username,
      readyTimeout: 30000
    };

    if (CONFIG.privateKeyPath && fs.existsSync(CONFIG.privateKeyPath)) {
      try {
        connOptions.privateKey = fs.readFileSync(CONFIG.privateKeyPath);
        if (CONFIG.passphrase) {
          connOptions.passphrase = CONFIG.passphrase;
        }
      } catch (e) {
        console.log('[SSH] Warning: could not read private key, falling back to password.');
      }
    }

    if (!connOptions.privateKey && CONFIG.password) {
      connOptions.password = CONFIG.password;
    }

    conn.on('ready', () => resolve(conn))
        .on('error', (err) => reject(err))
        .connect(connOptions);
  });
}

function runRemote(conn, command) {
  return new Promise((resolve, reject) => {
    console.log(`[Remote] Executing: ${command}`);
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Command failed with code ${code}\nStderr: ${stderr}`));
        } else {
          resolve(stdout);
        }
      }).on('data', (data) => {
        stdout += data.toString();
        process.stdout.write(data);
      }).stderr.on('data', (data) => {
        stderr += data.toString();
        process.stderr.write(data);
      });
    });
  });
}

function uploadSFTP(conn, localFile, remoteFile) {
  return new Promise((resolve, reject) => {
    console.log(`[SFTP] Uploading ${localFile} to ${remoteFile}...`);
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(localFile, remoteFile, {}, (uploadErr) => {
        if (uploadErr) reject(uploadErr);
        else {
          console.log(`[SFTP] Upload completed!`);
          resolve();
        }
      });
    });
  });
}

async function main() {
  const localArchive = path.join(__dirname, CONFIG.archiveName);
  const remoteArchive = `/root/${CONFIG.archiveName}`;

  try {
    console.log('=== STEP 1: Memaketkan project lokal ===');
    // Hapus archive lama jika ada
    if (fs.existsSync(localArchive)) {
      fs.unlinkSync(localArchive);
    }
    
    // Gunakan tar untuk mengompresi project
    await runLocal(`tar -czf "${CONFIG.archiveName}" --exclude=node_modules --exclude=.git --exclude="${CONFIG.archiveName}" *`);
    console.log('Project berhasil dikompresi.');

    console.log('\n=== STEP 2: Menghubungkan ke VPS via SSH ===');
    const conn = await connectSSH();
    console.log('Koneksi SSH berhasil terjalin.');

    try {
      console.log('\n=== STEP 3: Mengunggah file project ke VPS ===');
      await uploadSFTP(conn, localArchive, remoteArchive);

      console.log('\n=== STEP 4: Menyiapkan dependency di VPS (Node, PM2, Chromium) ===');
      // Update package list
      await runRemote(conn, 'apt-get update -y');
      
      // Instal Node.js (jika belum ada)
      await runRemote(conn, 'command -v node >/dev/null 2>&1 || (curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs)');
      
      // Instal PM2 (jika belum ada)
      await runRemote(conn, 'command -v pm2 >/dev/null 2>&1 || npm install -g pm2');

      // Instal dependency Puppeteer / Chromium
      console.log('Menginstal library sistem untuk Chromium headless...');
      await runRemote(conn, 'apt-get install -y libxfixes3 libxcursor1 libxss1 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libcairo2 libcups2t64 libdrm2 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxext6 libxi6 libxrender1 libxtst6 fonts-liberation libu2f-udev libvulkan1 xdg-utils || apt-get install -y libnss3 libnspr4 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2');

      console.log('\n=== STEP 5: Mengekstrak project di VPS ===');
      await runRemote(conn, `mkdir -p ${CONFIG.remotePath}`);
      await runRemote(conn, `tar -xzf ${remoteArchive} -C ${CONFIG.remotePath}`);

      console.log('\n=== STEP 6: Menginstal NPM modules di VPS ===');
      await runRemote(conn, `cd ${CONFIG.remotePath} && npm install --production`);

      console.log('\n=== STEP 7: Menjalankan aplikasi via PM2 & Firewall Configuration ===');
      await runRemote(conn, 'ufw allow 3005/tcp || true');
      await runRemote(conn, `cd ${CONFIG.remotePath} && (pm2 restart form-bot || pm2 start server.js --name form-bot) && pm2 save`);
      
      console.log('\n=== STEP 8: Cleanup file temp di VPS ===');
      await runRemote(conn, `rm -f ${remoteArchive}`);

      console.log('\n================================================');
      console.log('🎉 DEPLOYMENT BERHASIL!');
      console.log(`Aplikasi berjalan di VPS: http://${CONFIG.host}:3005`);
      console.log('================================================');

    } finally {
      conn.end();
    }
  } catch (error) {
    console.error('\n❌ Terjadi kesalahan saat deployment:', error.message);
  } finally {
    // Hapus archive lokal
    if (fs.existsSync(localArchive)) {
      fs.unlinkSync(localArchive);
    }
  }
}

main();
