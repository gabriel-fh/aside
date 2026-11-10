// Execucao local: baixa os binarios oficiais do whisper.cpp e do llama.cpp, baixa modelos,
// sobe os servidores em 127.0.0.1 e fala com eles por HTTP.

const { app } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const WHISPER_MODELS = [
  { id: 'tiny', mb: 78, note: 'o mais rápido, erra mais' },
  { id: 'base', mb: 148, note: 'equilíbrio para CPU' },
  { id: 'small', mb: 488, note: 'bem melhor em português' },
  { id: 'medium', mb: 1534, note: 'lento em CPU' },
  { id: 'large-v3-turbo', mb: 1625, note: 'melhor qualidade, pede GPU' },
];

const LLM_SUGGESTIONS = [
  {
    name: 'Qwen2.5 0.5B',
    mb: 398,
    note: 'minúsculo, só para testar',
    url: 'https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf',
  },
  {
    name: 'Qwen2.5 3B',
    mb: 1930,
    note: 'cabe em 4 GB de VRAM',
    url: 'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
  },
  {
    name: 'Gemma 3 4B',
    mb: 2490,
    note: 'cabe em 4 GB de VRAM',
    url: 'https://huggingface.co/bartowski/google_gemma-3-4b-it-GGUF/resolve/main/google_gemma-3-4b-it-Q4_K_M.gguf',
  },
  {
    name: 'Qwen2.5 7B',
    mb: 4683,
    note: 'melhor, parte roda na CPU',
    url: 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
  },
];

const BIN = {
  whisper: {
    repo: 'ggml-org/whisper.cpp',
    exe: 'whisper-server.exe',
    variants: {
      cpu: { label: 'CPU', pattern: /^whisper-bin-x64\.zip$/ },
      cuda: { label: 'NVIDIA CUDA 12', pattern: /^whisper-bin-win-cuda-12[\d.]*-x64\.zip$/ },
    },
  },
  llama: {
    repo: 'ggml-org/llama.cpp',
    exe: 'llama-server.exe',
    variants: {
      vulkan: { label: 'GPU (Vulkan)', pattern: /^llama-.*-bin-win-vulkan-x64\.zip$/ },
      cpu: { label: 'CPU', pattern: /^llama-.*-bin-win-cpu-x64\.zip$/ },
    },
  },
};

let getSettings = () => ({});
let onChange = () => {};
const downloads = new Map();
const servers = { whisper: null, llama: null };
const exeCache = new Map();

function init(options) {
  getSettings = options.getSettings;
  onChange = options.onChange;
}

/* ---------- caminhos ---------- */

const root = () => path.join(app.getPath('userData'), 'local');
const binDir = (kind, variant) => path.join(root(), `${kind}-${variant}`);
const whisperModelPath = (id) => path.join(root(), 'models', 'whisper', `ggml-${id}.bin`);
const llmDir = () => path.join(root(), 'models', 'llm');

function findFile(dir, name) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === name) return path.join(dir, entry.name);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findFile(path.join(dir, entry.name), name);
      if (found) return found;
    }
  }
  return null;
}

function exePath(kind, variant) {
  const key = `${kind}-${variant}`;
  const cached = exeCache.get(key);
  if (cached && fs.existsSync(cached)) return cached;
  const found = findFile(binDir(kind, variant), BIN[kind].exe);
  if (found) exeCache.set(key, found);
  else exeCache.delete(key);
  return found;
}

function readVersion(kind, variant) {
  try {
    return fs.readFileSync(path.join(binDir(kind, variant), 'version.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

/* ---------- estado para a interface ---------- */

let emitTimer = null;
function emit(throttled) {
  if (!throttled) {
    clearTimeout(emitTimer);
    emitTimer = null;
    onChange(status());
    return;
  }
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    onChange(status());
  }, 250);
}

function binStatus(kind, selected) {
  return Object.entries(BIN[kind].variants).map(([id, v]) => ({
    id,
    label: v.label,
    installed: Boolean(exePath(kind, id)),
    version: readVersion(kind, id),
    selected: id === selected,
  }));
}

function listLlmFiles() {
  try {
    return fs
      .readdirSync(llmDir())
      .filter((f) => f.toLowerCase().endsWith('.gguf'))
      .map((f) => {
        const full = path.join(llmDir(), f);
        return { name: f, path: full, mb: Math.round(fs.statSync(full).size / 1e6) };
      });
  } catch {
    return [];
  }
}

function status() {
  const s = getSettings();
  const progress = {};
  for (const [id, d] of downloads) progress[id] = { received: d.received, total: d.total };
  return {
    whisper: {
      variants: binStatus('whisper', s.whisperVariant),
      models: WHISPER_MODELS.map((m) => ({ ...m, installed: fs.existsSync(whisperModelPath(m.id)) })),
      running: Boolean(servers.whisper),
    },
    llama: {
      variants: binStatus('llama', s.llamaVariant),
      models: listLlmFiles(),
      suggestions: LLM_SUGGESTIONS.map((m) => ({
        ...m,
        file: path.basename(new URL(m.url).pathname),
      })),
      running: Boolean(servers.llama),
    },
    downloads: progress,
  };
}

/* ---------- downloads ---------- */

async function download(id, url, dest) {
  if (downloads.has(id)) throw new Error('Este download já está em andamento.');
  const controller = new AbortController();
  const entry = { received: 0, total: 0, controller };
  downloads.set(id, entry);
  emit();
  const part = `${dest}.part`;
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download falhou (${res.status}).`);
    entry.total = Number(res.headers.get('content-length')) || 0;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const counter = new Transform({
      transform(chunk, _encoding, done) {
        entry.received += chunk.length;
        emit(true);
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part));
    await fsp.rename(part, dest);
  } catch (error) {
    await fsp.rm(part, { force: true });
    throw controller.signal.aborted ? new Error('Download cancelado.') : error;
  } finally {
    downloads.delete(id);
    emit();
  }
}

function cancelDownload(id) {
  const entry = downloads.get(id);
  if (entry) entry.controller.abort();
}

function extractZip(zip, dir) {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', zip, '-C', dir], { windowsHide: true }, (error, _out, stderr) => {
      if (error) reject(new Error(`Falha ao extrair: ${String(stderr || error.message).slice(0, 200)}`));
      else resolve();
    });
  });
}

// Procura, nas builds mais recentes do projeto oficial, o pacote da variante pedida.
async function findAsset(kind, variant) {
  const spec = BIN[kind];
  const res = await fetch(`https://api.github.com/repos/${spec.repo}/releases?per_page=20`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status} ao listar as builds.`);
  const releases = await res.json();
  const pattern = spec.variants[variant].pattern;
  for (const release of releases) {
    const asset = (release.assets || []).find((a) => pattern.test(a.name));
    if (asset) return { tag: release.tag_name, name: asset.name, url: asset.browser_download_url };
  }
  throw new Error('Nenhuma build recente tem esse pacote para Windows.');
}

async function installBinary(kind, variant) {
  if (!BIN[kind] || !BIN[kind].variants[variant]) throw new Error('Variante desconhecida.');
  const asset = await findAsset(kind, variant);
  const dir = binDir(kind, variant);
  const zip = `${dir}.zip`;
  await download(`bin:${kind}:${variant}`, asset.url, zip);
  await stop(kind);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  try {
    await extractZip(zip, dir);
  } finally {
    await fsp.rm(zip, { force: true });
  }
  await fsp.writeFile(path.join(dir, 'version.txt'), asset.tag);
  exeCache.delete(`${kind}-${variant}`);
  if (!exePath(kind, variant)) throw new Error(`O pacote não trouxe ${BIN[kind].exe}.`);
  emit();
  return asset.tag;
}

async function downloadWhisperModel(id) {
  if (!WHISPER_MODELS.some((m) => m.id === id)) throw new Error('Modelo desconhecido.');
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${id}.bin`;
  await download(`whisper:${id}`, url, whisperModelPath(id));
}

async function downloadLlmModel(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Endereço inválido.');
  }
  const file = path.basename(parsed.pathname);
  if (parsed.protocol !== 'https:' || !file.toLowerCase().endsWith('.gguf')) {
    throw new Error('Informe um endereço https que termine em .gguf.');
  }
  const dest = path.join(llmDir(), file);
  await download(`llm:${file}`, parsed.href, dest);
  return dest;
}

async function deleteModel(kind, name) {
  if (kind === 'whisper') {
    if (!WHISPER_MODELS.some((m) => m.id === name)) return;
    if (getSettings().whisperModel === name) await stop('whisper');
    await fsp.rm(whisperModelPath(name), { force: true });
  } else {
    const target = path.join(llmDir(), path.basename(name));
    if (getSettings().llamaModel === target) await stop('llama');
    await fsp.rm(target, { force: true });
  }
  emit();
}

/* ---------- servidores ---------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function wantedConfig(kind) {
  const s = getSettings();
  if (kind === 'whisper') {
    const exe = exePath('whisper', s.whisperVariant);
    if (!exe) throw new Error('Instale o Whisper local em Ajustes, aba Local.');
    const model = whisperModelPath(s.whisperModel);
    if (!fs.existsSync(model)) throw new Error(`Baixe o modelo Whisper "${s.whisperModel}" em Ajustes, aba Local.`);
    const threads = String(Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2))));
    return { exe, key: `${exe}|${model}`, args: (port) => ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-t', threads], health: '/' };
  }
  const exe = exePath('llama', s.llamaVariant);
  if (!exe) throw new Error('Instale o llama.cpp em Ajustes, aba Local.');
  const model = s.llamaModel;
  if (!model || !fs.existsSync(model)) throw new Error('Escolha um modelo local em Ajustes, aba Local.');
  const ctx = String(s.llamaContext || 8192);
  return { exe, key: `${exe}|${model}|${ctx}`, args: (port) => ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-c', ctx], health: '/health' };
}

async function ensure(kind) {
  const config = wantedConfig(kind);
  const current = servers[kind];
  if (current && current.key === config.key) return current.ready;
  await stop(kind);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(config.exe, config.args(port), { cwd: path.dirname(config.exe), windowsHide: true });
  let log = '';
  const keep = (chunk) => {
    log = (log + chunk.toString()).slice(-2000);
  };
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);

  const server = { proc, key: config.key, base, exited: false, ready: null };
  proc.on('exit', () => {
    server.exited = true;
    if (servers[kind] === server) {
      servers[kind] = null;
      emit();
    }
  });
  proc.on('error', keep);

  server.ready = (async () => {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if (server.exited) {
        const tail = log.trim().split('\n').slice(-3).join(' ');
        throw new Error(`O servidor local encerrou ao iniciar. ${tail}`.slice(0, 400));
      }
      try {
        const res = await fetch(base + config.health);
        if (res.ok) return base;
      } catch {
        // ainda subindo
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('O servidor local demorou demais para iniciar.');
  })();
  server.ready.catch(() => {
    if (servers[kind] === server) stop(kind);
  });

  servers[kind] = server;
  emit();
  return server.ready;
}

async function stop(kind) {
  const server = servers[kind];
  if (!server) return;
  servers[kind] = null;
  if (!server.exited) {
    await new Promise((resolve) => {
      server.proc.once('exit', resolve);
      server.proc.kill();
      setTimeout(resolve, 3000);
    });
  }
  emit();
}

function stopAll() {
  for (const kind of Object.keys(servers)) {
    const server = servers[kind];
    servers[kind] = null;
    if (server && !server.exited) server.proc.kill();
  }
}

/* ---------- uso ---------- */

async function transcribe({ wavBase64, language, signal }) {
  const base = await ensure('whisper');
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(wavBase64, 'base64')], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (language && language !== 'auto') form.append('language', language);
  const res = await fetch(`${base}/inference`, { method: 'POST', body: form, signal });
  if (!res.ok) throw new Error(`Whisper local respondeu ${res.status}.`);
  const json = await res.json();
  if (json.error) throw new Error(String(json.error));
  return String(json.text || '').replace(/\s+/g, ' ').trim();
}

const llamaBase = async () => `${await ensure('llama')}/v1`;

module.exports = {
  init,
  status,
  installBinary,
  downloadWhisperModel,
  downloadLlmModel,
  deleteModel,
  cancelDownload,
  transcribe,
  llamaBase,
  ensure,
  stop,
  stopAll,
};
