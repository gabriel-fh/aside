// Cota do servico de nuvem. Junta duas fontes:
// o que o servico informa nos cabecalhos (pedidos restantes) e o que o proprio Aside gastou em 24 horas.
// O limite diario de tokens nao vem em cabecalho nenhum, entao a conta e feita aqui.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;

let data = null; // { log: { modelo: [[quando, tokens]] }, dayLimit: { modelo: n } }
let saveTimer = null;
const headers = new Map(); // modelo -> ultimo conjunto de cabecalhos

function file() {
  return path.join(app.getPath('userData'), 'quota.json');
}

function load() {
  if (data) return data;
  try {
    data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    data = {};
  }
  if (!data.log || typeof data.log !== 'object') data.log = {};
  if (!data.dayLimit || typeof data.dayLimit !== 'object') data.dayLimit = {};
  return data;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(data));
    } catch {
      // sem disco, o medidor vale so para esta execucao
    }
  }, 400);
}

function entries(model) {
  const log = load().log;
  const cut = Date.now() - DAY;
  log[model] = (log[model] || []).filter(([when]) => when > cut);
  return log[model];
}

function used(model) {
  return entries(model).reduce((sum, [, tokens]) => sum + tokens, 0);
}

function add(model, tokens) {
  if (!(tokens > 0)) return;
  entries(model).push([Date.now(), Math.round(tokens)]);
  save();
}

// Chamado a cada resposta do servico.
function note({ model, limits, tokens }) {
  if (!model) return;
  if (limits) headers.set(model, limits);
  add(model, tokens);
}

// O erro de cota diaria do Groq traz o limite e o consumo reais: aproveita para acertar a conta.
function learn(model, message) {
  const match = String(message || '').match(/tokens per day[^:]*:\s*Limit\s+(\d+),\s*Used\s+(\d+)/i);
  if (!match) return;
  const limit = Number(match[1]);
  const real = Number(match[2]);
  if (limit > 0) load().dayLimit[model] = limit;
  // Consumo feito fora do Aside (ou antes desta instalacao) entra como diferenca.
  if (real > used(model)) add(model, real - used(model));
  save();
}

// Retrato para a interface. `fallbackLimit` e o limite diario informado em Ajustes.
function view(model, fallbackLimit = 0) {
  const limit = load().dayLimit[model] || fallbackLimit || 0;
  const spent = used(model);
  const info = headers.get(model) || {};
  return {
    model,
    used: spent,
    limit,
    left: limit ? Math.max(0, limit - spent) : null,
    reqLeft: info.reqLeft ?? null,
    reqLimit: info.reqLimit ?? null,
  };
}

module.exports = { note, learn, view };
