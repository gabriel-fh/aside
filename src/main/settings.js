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
  captureMic: true,
  captureSystem: true,
  speakerMode: false,
  opacity: 0.9,
  activeAssistantId: 'reuniao',
  obsidianVault: '',
  shortcuts: {
    toggle: 'Control+Shift+Space',
    ask: 'Control+Shift+Enter',
    screen: 'Control+Shift+L',
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
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
}

function publicView() {
  const { apiKeyEnc, ...rest } = load();
  return { ...rest, hasKey: Boolean(apiKeyEnc) };
}

function update(patch) {
  load();
  const { apiKeyEnc, hasKey, ...safe } = patch || {};
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

module.exports = { DEFAULTS, load, publicView, update, setApiKey, getApiKey };
