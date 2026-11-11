// Configuracoes em JSON na pasta de dados do usuario.
// A chave de API fica cifrada com o cofre do sistema (safeStorage) e nunca vai para a interface.

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { DEFAULT_ASSISTANTS } = require('./prompts');

const DEFAULTS = {
  chatModel: '~google/gemini-flash-latest',
  transcribeModel: '~google/gemini-flash-latest',
  language: 'português do Brasil',
  responseLanguage: 'português do Brasil',
  translateTo: '',
  stealth: false,
  autoInsights: true,
  autoSummary: true,
  economy: true,
  hybridLocal: false,
  localFallback: false,
  captureMic: true,
  captureSystem: true,
  speakerMode: false,
  opacity: 0.9,
  activeAssistantId: 'reuniao',
  obsidianVault: '',
  transcribeProvider: 'openrouter',
  chatProvider: 'openrouter',
  whisperVariant: 'cpu',
  whisperModel: 'base',
  whisperLang: 'pt',
  llamaVariant: 'vulkan',
  llamaModel: '',
  llamaContext: 8192,
  customBase: '',
  customModel: '',
  customBackupModel: '',
  dayTokenLimit: 200000,
  shortcuts: {
    toggle: 'Control+Shift+Space',
    ask: 'Control+Shift+Enter',
    screen: 'Control+Shift+L',
    region: 'Control+Shift+X',
    session: 'Control+Shift+K',
    up: 'Control+Alt+Up',
    down: 'Control+Alt+Down',
    left: 'Control+Alt+Left',
    right: 'Control+Alt+Right',
  },
  assistants: DEFAULT_ASSISTANTS,
};

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cache) return cache;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    raw = {};
  }
  cache = { ...DEFAULTS, ...raw, shortcuts: { ...DEFAULTS.shortcuts, ...(raw.shortcuts || {}) } };
  if (!Array.isArray(cache.assistants) || cache.assistants.length === 0) {
    cache.assistants = DEFAULT_ASSISTANTS;
  }
  // Modos padrao criados depois da primeira versao entram uma unica vez em instalacoes antigas.
  if ((cache.seed || 0) < 2) {
    if (!cache.assistants.some((a) => a.id === 'entrevista')) {
      cache.assistants = [...cache.assistants, DEFAULT_ASSISTANTS.find((a) => a.id === 'entrevista')];
    }
    cache.seed = 2;
  }
  if (cache.seed < 3) {
    cache.assistants = cache.assistants.map((a) => (a.id === 'entrevista' ? { ...a, interview: true } : a));
    cache.seed = 3;
  }
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
}

function publicView() {
  const { apiKeyEnc, mcpEnc, customKeyEnc, ...rest } = load();
  return { ...rest, hasKey: Boolean(apiKeyEnc), hasCustomKey: Boolean(customKeyEnc) };
}

function update(patch) {
  load();
  const { apiKeyEnc, mcpEnc, customKeyEnc, hasKey, hasCustomKey, ready, ...safe } = patch || {};
  Object.assign(cache, safe);
  save();
  return publicView();
}

function setApiKey(key) {
  load();
  const value = String(key || '').trim();
  if (!value) {
    delete cache.apiKeyEnc;
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('O cofre de credenciais do sistema não está disponível.');
    }
    cache.apiKeyEnc = safeStorage.encryptString(value).toString('base64');
  }
  save();
  return publicView();
}

function getApiKey() {
  load();
  if (!cache.apiKeyEnc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(cache.apiKeyEnc, 'base64'));
  } catch {
    return '';
  }
}

// Chave de outro servico de IA compativel com a API da OpenAI.
function setCustomKey(key) {
  load();
  const value = String(key || '').trim();
  if (!value) delete cache.customKeyEnc;
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('O cofre de credenciais do sistema não está disponível.');
    cache.customKeyEnc = safeStorage.encryptString(value).toString('base64');
  }
  save();
}

function getCustomKey() {
  load();
  if (!cache.customKeyEnc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(cache.customKeyEnc, 'base64'));
  } catch {
    return '';
  }
}

// Servidores MCP: a configuracao pode conter tokens, entao fica toda cifrada.
function getMcpServers() {
  load();
  if (!cache.mcpEnc) return [];
  try {
    const list = JSON.parse(safeStorage.decryptString(Buffer.from(cache.mcpEnc, 'base64')));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function setMcpServers(list) {
  load();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('O cofre de credenciais do sistema não está disponível.');
  }
  cache.mcpEnc = safeStorage.encryptString(JSON.stringify(list || [])).toString('base64');
  save();
}

module.exports = {
  DEFAULTS,
  load,
  publicView,
  update,
  setApiKey,
  getApiKey,
  setCustomKey,
  getCustomKey,
  getMcpServers,
  setMcpServers,
};
