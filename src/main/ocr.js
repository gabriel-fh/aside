// Texto da tela pelo OCR embutido do Windows, para modelos que nao leem imagem.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// No app empacotado o script fica fora do pacote compactado, senao o PowerShell nao consegue abrir.
const SCRIPT = path.join(__dirname, 'ocr.ps1').replace('app.asar', 'app.asar.unpacked');
const MAX_CHARS = 12000;

function readScreenText(pngBuffer) {
  const file = path.join(app.getPath('temp'), `aside-tela-${process.pid}-${Date.now()}.png`);
  fs.writeFileSync(file, pngBuffer);
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Path', file],
      { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        fs.rm(file, { force: true }, () => {});
        if (error) {
          const detail = String(stderr || error.message).trim().split('\n')[0];
          reject(new Error(`Não consegui ler o texto da tela. ${detail}`.slice(0, 300)));
          return;
        }
        resolve(String(stdout).replace(/\r/g, '').trim().slice(0, MAX_CHARS));
      }
    );
  });
}

module.exports = { readScreenText };
