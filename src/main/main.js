const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  session: electronSession,
  shell,
} = require('electron');
const fs = require('fs');
const path = require('path');

const settings = require('./settings');
const db = require('./db');
const openrouter = require('./openrouter');
const local = require('./local');
const mcp = require('./mcp');
const { extractFile } = require('./context');
const { SPEAKER_LABEL, buildChatMessages, buildSummaryMessages } = require('./prompts');

const ROOT = path.join(__dirname, '..', '..');
const LOGO = path.join(ROOT, 'assets', 'logo.png');
const PRELOAD = path.join(__dirname, '..', 'preload.js');
const SHOT_DIR = process.env.ASIDE_SHOT_DIR || '';

const OVERLAY_SIZE = { width: 780, height: 640 };

let overlay = null;
let settingsWin = null;
let tray = null;

// Estado da sessao ao vivo. `lines` e `turns` alimentam o contexto do modelo.
const live = { id: null, startedAt: null, lines: [], turns: [] };
let lastReady = null;
let currentAsk = null;
let askSeq = 0;
let autoTimer = null;

function broadcast(channel, payload) {
  for (const win of [overlay, settingsWin]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function status(kind, message) {
  broadcast('status', { kind, message });
}

const NO_KEY = 'Informe a chave do OpenRouter em Ajustes.';

const customBase = () => String(settings.load().customBase || '').trim().replace(/\/+$/, '');

// Para onde vai o chat: OpenRouter, outro servico compativel ou o llama.cpp local.
async function chatTarget() {
  const s = settings.load();
  if (s.chatProvider === 'local') {
    return { base: await local.llamaBase(), key: '', model: 'local', local: true };
  }
  if (s.chatProvider === 'custom') {
    const base = customBase();
    if (!base || !s.customModel) throw new Error('Preencha o endereço e o modelo do outro serviço em Ajustes.');
    return { base, key: settings.getCustomKey(), model: s.customModel, local: false };
  }
  const key = settings.getApiKey();
  if (!key) throw new Error(NO_KEY);
  return { key, model: s.chatModel, local: false };
}

// O servidor local roda sem leitor de imagem: manda so o texto.
function textOnly(messages) {
  return messages.map((m) =>
    Array.isArray(m.content)
      ? { ...m, content: m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') }
      : m
  );
}

async function translate(text, to) {
  const target = await chatTarget();
  const out = await openrouter.complete({
    ...target,
    messages: [
      { role: 'system', content: `Traduza o texto do usuário para ${to}. Responda só com a tradução.` },
      { role: 'user', content: text },
    ],
  });
  return out.trim();
}

// Verdadeiro quando ha IA configurada para transcrever e para responder (nuvem ou local).
function aiReady() {
  const s = settings.load();
  const hasKey = Boolean(settings.getApiKey());
  const state = local.status();
  const engine = (kind) => state[kind].variants.some((v) => v.selected && v.installed);
  const whisperOk = engine('whisper') && state.whisper.models.some((m) => m.id === s.whisperModel && m.installed);
  const llamaOk = engine('llama') && Boolean(s.llamaModel) && fs.existsSync(s.llamaModel);
  const chatOk =
    s.chatProvider === 'local' ? llamaOk : s.chatProvider === 'custom' ? Boolean(customBase() && s.customModel) : hasKey;
  return (s.transcribeProvider === 'local' ? whisperOk : hasKey) && chatOk;
}

function viewSettings() {
  return { ...settings.publicView(), ready: aiReady() };
}

function sessionState() {
  return { active: Boolean(live.id), id: live.id, startedAt: live.startedAt };
}

/* ---------- janelas ---------- */

function createOverlay() {
  const area = screen.getPrimaryDisplay().workArea;
  const { width, height } = OVERLAY_SIZE;
  overlay = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y + 16,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    icon: LOGO,
    webPreferences: { preload: PRELOAD, contextIsolation: true, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.loadFile(path.join(ROOT, 'src', 'renderer', 'overlay.html'));
  overlay.once('ready-to-show', () => overlay.showInactive());
  overlay.on('closed', () => {
    overlay = null;
  });
  logConsole(overlay, 'overlay');
}

function openSettings(tab) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    if (tab) settingsWin.webContents.send('cmd', { type: 'tab', tab });
    return;
  }
  settingsWin = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 520,
    minHeight: 460,
    title: 'Aside',
    backgroundColor: '#0c0c0d',
    autoHideMenuBar: true,
    icon: LOGO,
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  settingsWin.loadFile(path.join(ROOT, 'src', 'renderer', 'settings.html'), tab ? { hash: tab } : undefined);
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  applyStealth();
  logConsole(settingsWin, 'settings');
}

function logConsole(win, name) {
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.log(`[${name}] ${event.level}: ${event.message}`);
    }
  });
}

function toggleOverlay() {
  if (!overlay) return;
  if (overlay.isVisible()) overlay.hide();
  else overlay.showInactive();
}

function moveOverlay(dx, dy) {
  if (!overlay) return;
  // Com escala de tela no Windows, mover so pela posicao faz a janela crescer a cada passo.
  // Reafirmar o tamanho junto com a posicao evita isso.
  const [x, y] = overlay.getPosition();
  overlay.setBounds({ x: Math.round(x + dx), y: Math.round(y + dy), ...OVERLAY_SIZE });
}

// Modo stealth: as janelas somem de capturas e compartilhamento de tela, e da barra de tarefas.
function applyStealth() {
  const on = Boolean(settings.load().stealth);
  if (overlay && !overlay.isDestroyed()) overlay.setContentProtection(on);
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.setContentProtection(on);
    settingsWin.setSkipTaskbar(on);
  }
}

function buildTray() {
  const icon = nativeImage.createFromPath(LOGO).resize({ width: 16, height: 16 });
  if (!tray) {
    tray = new Tray(icon);
    tray.setToolTip('Aside');
    tray.on('click', toggleOverlay);
  }
  const s = settings.load();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Mostrar ou ocultar', click: toggleOverlay },
      { label: 'Ajustes', click: () => openSettings() },
      {
        label: 'Modo stealth',
        type: 'checkbox',
        checked: Boolean(s.stealth),
        click: (item) => changeSettings({ stealth: item.checked }),
      },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() },
    ])
  );
}

/* ---------- atalhos ---------- */

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const sc = settings.load().shortcuts;
  const actions = {
    toggle: toggleOverlay,
    ask: () => ask({}),
    screen: () => ask({ withScreen: true }),
    session: () => overlay && overlay.webContents.send('cmd', { type: 'toggle-session' }),
    up: () => moveOverlay(0, -40),
    down: () => moveOverlay(0, 40),
    left: () => moveOverlay(-40, 0),
    right: () => moveOverlay(40, 0),
  };
  const failed = [];
  for (const [name, fn] of Object.entries(actions)) {
    const accel = sc[name];
    if (!accel) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(accel, fn);
    } catch {
      ok = false;
    }
    if (!ok) failed.push(accel);
  }
  if (failed.length) status('error', `Atalho indisponível: ${failed.join(', ')}`);
  return failed;
}

function changeSettings(patch) {
  settings.update(patch);
  const next = viewSettings();
  lastReady = next.ready;
  if ('stealth' in patch) applyStealth();
  if ('shortcuts' in patch) registerShortcuts();
  if (next.transcribeProvider !== 'local') local.stop('whisper');
  if (next.chatProvider !== 'local') local.stop('llama');
  buildTray();
  broadcast('settings', next);
  return next;
}

/* ---------- captura de tela ---------- */

async function captureScreen() {
  const display = overlay ? screen.getDisplayMatching(overlay.getBounds()) : screen.getPrimaryDisplay();
  const width = 1600;
  const height = Math.round((width * display.size.height) / display.size.width);
  // O overlay fica fora da imagem enviada ao modelo.
  const stealth = Boolean(settings.load().stealth);
  if (overlay && !stealth) overlay.setContentProtection(true);
  try {
    if (!stealth) await new Promise((r) => setTimeout(r, 80));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!source) throw new Error('Nenhuma tela disponível para captura.');
    return `data:image/jpeg;base64,${source.thumbnail.toJPEG(72).toString('base64')}`;
  } finally {
    if (overlay && !overlay.isDestroyed() && !stealth) overlay.setContentProtection(false);
  }
}

/* ---------- perguntas ao modelo ---------- */

async function ask({ text = '', withScreen = false, auto = false } = {}) {
  const s = settings.publicView();
  const useLocal = s.chatProvider === 'local';
  if (s.chatProvider === 'openrouter' && !s.hasKey) {
    status('error', NO_KEY);
    if (!auto) openSettings('geral');
    return;
  }
  if (currentAsk) currentAsk.abort();
  const controller = new AbortController();
  currentAsk = controller;
  const id = ++askSeq;

  const typed = String(text || '').trim();
  const request =
    typed ||
    (withScreen
      ? 'Analise o que está na tela e me ajude com isso.'
      : 'Com base na conversa até aqui, o que é mais útil eu saber ou dizer agora?');
  const label = typed || (withScreen ? 'Análise da tela' : 'O que vem agora?');
  const assistant = s.assistants.find((a) => a.id === s.activeAssistantId) || s.assistants[0];

  if (overlay && !overlay.isVisible() && !auto) overlay.showInactive();
  broadcast('answer:start', { id, question: label, auto });

  let full = '';
  try {
    if (withScreen && useLocal) status('info', 'O modelo local não lê imagens: a tela foi ignorada.');
    const target = await chatTarget();
    const imageDataUrl = withScreen && !useLocal ? await captureScreen() : null;
    const messages = buildChatMessages({
      assistant,
      responseLanguage: s.responseLanguage,
      lines: live.lines,
      turns: live.turns,
      request,
      imageDataUrl,
      contextLimit: target.local ? 12000 : 120000,
    });
    // Ferramentas so em perguntas feitas pelo usuario e com modelo na nuvem.
    const tools = auto || target.local ? [] : mcp.toolsForModel();
    full = await openrouter.runChat({
      ...target,
      messages: target.local ? textOnly(messages) : messages,
      tools,
      signal: controller.signal,
      onDelta: (delta) => broadcast('answer:delta', { id, text: delta }),
      callTool: (name, args) => mcp.call(name, args),
      onTool: (name) => status('info', `Usando ferramenta: ${mcp.label(name)}`),
    });
    live.turns.push({ q: request, a: full });
    if (live.turns.length > 20) live.turns.shift();
    db.addEntry(live.id, { kind: 'question', text: label });
    db.addEntry(live.id, { kind: 'answer', text: full });
    broadcast('answer:end', { id });
  } catch (error) {
    const aborted = controller.signal.aborted;
    broadcast('answer:end', { id, error: aborted ? null : error.message, aborted });
  } finally {
    if (currentAsk === controller) currentAsk = null;
  }
}

// Sugestao automatica quando a outra parte faz uma pergunta.
function maybeAutoInsight(line) {
  const s = settings.load();
  if (!s.autoInsights || line.speaker !== 'them' || !line.text.includes('?')) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    if (!live.id || currentAsk) return;
    ask({
      auto: true,
      text: `Eles acabaram de dizer: "${line.text}". Se for uma pergunta para mim, dê a resposta de forma breve. Se não for, aponte o ponto principal em uma frase.`,
    });
  }, 1200);
}

// Ferramenta que altera algo fora do app so roda com o seu aval, a menos que o servidor seja de confianca.
async function confirmTool({ server, tool, args }) {
  const parent = overlay && overlay.isVisible() ? overlay : settingsWin || undefined;
  const options = {
    type: 'question',
    buttons: ['Executar', 'Negar'],
    defaultId: 1,
    cancelId: 1,
    title: 'Aside',
    message: `Executar a ferramenta "${tool}" de ${server}?`,
    detail: JSON.stringify(args, null, 2).slice(0, 1500),
  };
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return result.response === 0;
}

function mcpState() {
  return { servers: settings.getMcpServers(), status: mcp.status() };
}

/* ---------- sessao e transcricao ---------- */

function startSession() {
  if (live.id) return sessionState();
  const s = settings.load();
  live.id = db.createSession({ assistant: s.activeAssistantId, model: s.chatModel });
  live.startedAt = Date.now();
  live.lines = [];
  live.turns = [];
  broadcast('session', sessionState());
  // Sobe o Whisper local ja no inicio, para a primeira fala nao esperar o modelo carregar.
  if (s.transcribeProvider === 'local') {
    local.ensure('whisper').catch((error) => status('error', error.message));
  }
  return sessionState();
}

async function stopSession() {
  if (!live.id) return sessionState();
  const id = live.id;
  const lines = live.lines.slice();
  const turns = live.turns.slice();
  db.endSession(id);
  live.id = null;
  live.startedAt = null;
  clearTimeout(autoTimer);
  broadcast('session', sessionState());
  if (settings.load().autoSummary && lines.length >= 4) {
    summarize(id, lines, turns).catch((error) => status('error', `Resumo falhou: ${error.message}`));
  }
  return sessionState();
}

async function summarize(id, lines, turns) {
  const s = settings.load();
  const target = await chatTarget();
  const text = await openrouter.complete({
    ...target,
    messages: buildSummaryMessages({ lines, turns, responseLanguage: s.responseLanguage }),
  });
  const [first, ...rest] = text.trim().split('\n');
  const title = first.replace(/^#+\s*/, '').trim().slice(0, 120) || 'Sessão';
  db.setSummary(id, title, rest.join('\n').trim());
  status('info', `Resumo pronto: ${title}`);
  return db.getSession(id);
}

function sessionFromDb(id) {
  const data = db.getSession(id);
  if (!data) throw new Error('Sessão não encontrada.');
  const lines = data.entries.filter((e) => e.kind === 'transcript').map((e) => ({ speaker: e.speaker, text: e.text }));
  const turns = [];
  let pending = null;
  for (const e of data.entries) {
    if (e.kind === 'question') pending = e.text;
    else if (e.kind === 'answer' && pending !== null) {
      turns.push({ q: pending, a: e.text });
      pending = null;
    }
  }
  return { data, lines, turns };
}

async function handleSegment({ speaker, wavBase64, ts }) {
  if (!live.id) return;
  const sessionId = live.id;
  const s = settings.load();
  try {
    let text = '';
    let translation = '';
    if (s.transcribeProvider === 'local') {
      text = openrouter.cleanTranscript(await local.transcribe({ wavBase64, language: s.whisperLang }));
      if (text && s.translateTo) translation = await translate(text, s.translateTo).catch(() => '');
    } else {
      const key = settings.getApiKey();
      if (!key) throw new Error(NO_KEY);
      ({ text, translation } = await openrouter.transcribe({
        key,
        model: s.transcribeModel,
        wavBase64,
        language: s.language,
        translateTo: s.translateTo,
      }));
    }
    if (!text) return;
    const line = { speaker, text, translation, ts: ts || Date.now() };
    db.addEntry(sessionId, { kind: 'transcript', speaker, text, extra: translation || null, ts: line.ts });
    if (live.id === sessionId) {
      live.lines.push(line);
      if (live.lines.length > 400) live.lines.shift();
      broadcast('transcript', line);
      maybeAutoInsight(line);
    }
  } catch (error) {
    status('error', `Transcrição falhou: ${error.message}`);
  }
}

/* ---------- exportacao ---------- */

function sessionMarkdown(data) {
  const { session: sess, entries } = data;
  const date = new Date(sess.started_at);
  const out = [`# ${sess.title || 'Sessão'}`, '', `Data: ${date.toLocaleString('pt-BR')}`, ''];
  if (sess.summary) out.push('## Resumo', '', sess.summary, '');
  const transcript = entries.filter((e) => e.kind === 'transcript');
  if (transcript.length) {
    out.push('## Transcrição', '');
    for (const e of transcript) out.push(`**${SPEAKER_LABEL[e.speaker] || e.speaker}:** ${e.text}`, '');
  }
  const qa = entries.filter((e) => e.kind !== 'transcript');
  if (qa.length) {
    out.push('## Perguntas ao assistente', '');
    for (const e of qa) out.push(e.kind === 'question' ? `### ${e.text}` : e.text, '');
  }
  return out.join('\n');
}

async function exportSession(id) {
  const data = db.getSession(id);
  if (!data) throw new Error('Sessão não encontrada.');
  const date = new Date(data.session.started_at).toISOString().slice(0, 10);
  const safeTitle = (data.session.title || 'Sessão').replace(/[\\/:*?"<>|]/g, ' ').trim();
  const name = `${date} ${safeTitle}.md`;
  const vault = settings.load().obsidianVault;
  let target;
  if (vault && fs.existsSync(vault)) {
    const dir = path.join(vault, 'Aside');
    fs.mkdirSync(dir, { recursive: true });
    target = path.join(dir, name);
  } else {
    const result = await dialog.showSaveDialog(settingsWin || undefined, {
      defaultPath: name,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return null;
    target = result.filePath;
  }
  fs.writeFileSync(target, sessionMarkdown(data), 'utf8');
  return target;
}

/* ---------- IPC ---------- */

function registerIpc() {
  ipcMain.handle('settings:get', () => viewSettings());
  ipcMain.handle('settings:set', (_e, patch) => changeSettings(patch || {}));
  ipcMain.handle('key:set', (_e, key) => {
    settings.setApiKey(key);
    const next = viewSettings();
    lastReady = next.ready;
    broadcast('settings', next);
    return next;
  });
  ipcMain.handle('custom-key:set', (_e, key) => {
    settings.setCustomKey(key);
    const next = viewSettings();
    lastReady = next.ready;
    broadcast('settings', next);
    return next;
  });
  ipcMain.handle('custom:models', async () => {
    const base = customBase();
    if (!base) throw new Error('Informe o endereço da API primeiro.');
    const key = settings.getCustomKey();
    const res = await fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
    if (!res.ok) throw new Error(`O serviço respondeu ${res.status} ao listar os modelos.`);
    const json = await res.json();
    const list = Array.isArray(json) ? json : json.data || json.models || [];
    return list.map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
  });
  ipcMain.handle('models:list', (_e, force) => openrouter.listModels(Boolean(force)));

  ipcMain.handle('session:start', () => startSession());
  ipcMain.handle('session:stop', () => stopSession());
  ipcMain.handle('session:state', () => sessionState());
  ipcMain.handle('audio:segment', (_e, segment) => {
    handleSegment(segment || {});
  });
  ipcMain.handle('audio:desktop-source', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    return sources[0] ? sources[0].id : null;
  });

  ipcMain.handle('ask', (_e, request) => {
    ask(request || {});
  });
  ipcMain.handle('ask:cancel', () => {
    if (currentAsk) currentAsk.abort();
  });

  ipcMain.handle('history:list', (_e, query) => db.listSessions(query));
  ipcMain.handle('history:get', (_e, id) => db.getSession(id));
  ipcMain.handle('history:delete', (_e, id) => db.deleteSession(id));
  ipcMain.handle('history:summarize', (_e, id) => {
    const { lines, turns } = sessionFromDb(id);
    if (!lines.length && !turns.length) throw new Error('Sessão vazia, nada para resumir.');
    return summarize(id, lines, turns);
  });
  ipcMain.handle('history:export', (_e, id) => exportSession(id));
  ipcMain.handle('dialog:folder', async () => {
    const result = await dialog.showOpenDialog(settingsWin || undefined, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('context:pick', async () => {
    const result = await dialog.showOpenDialog(settingsWin || undefined, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documentos', extensions: ['pdf', 'docx', 'txt', 'md', 'csv', 'json'] },
        { name: 'Todos os arquivos', extensions: ['*'] },
      ],
    });
    if (result.canceled) return [];
    return Promise.all(result.filePaths.map(extractFile));
  });

  ipcMain.handle('mcp:get', () => mcpState());
  ipcMain.handle('mcp:save', (_e, servers) => {
    settings.setMcpServers(servers);
    mcp.sync(settings.getMcpServers());
    return mcpState();
  });
  ipcMain.handle('mcp:reconnect', async (_e, id) => {
    await mcp.reconnect(id);
    return mcpState();
  });

  ipcMain.handle('local:status', () => local.status());
  ipcMain.handle('local:install', (_e, kind, variant) => local.installBinary(kind, variant));
  ipcMain.handle('local:whisper-model', (_e, id) => local.downloadWhisperModel(id));
  ipcMain.handle('local:llm-model', async (_e, url) => {
    const file = await local.downloadLlmModel(url);
    if (!settings.load().llamaModel) changeSettings({ llamaModel: file });
    return file;
  });
  ipcMain.handle('local:delete', (_e, kind, name) => local.deleteModel(kind, name));
  ipcMain.handle('local:cancel', (_e, id) => local.cancelDownload(id));
  ipcMain.handle('local:pick-gguf', async () => {
    const result = await dialog.showOpenDialog(settingsWin || undefined, {
      properties: ['openFile'],
      filters: [{ name: 'Modelo GGUF', extensions: ['gguf'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.on('overlay:ignore', (_e, ignore) => {
    if (overlay) overlay.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
  });
  ipcMain.on('overlay:move-by', (_e, dx, dy) => moveOverlay(Number(dx) || 0, Number(dy) || 0));
  ipcMain.on('overlay:hide', () => overlay && overlay.hide());
  ipcMain.on('overlay:show', () => overlay && overlay.showInactive());
  ipcMain.on('home:toggle-session', () => {
    if (!overlay) return;
    overlay.showInactive();
    overlay.webContents.send('cmd', { type: 'toggle-session' });
  });
  ipcMain.on('open:keys', () => shell.openExternal('https://openrouter.ai/keys'));
  ipcMain.on('settings:open', (_e, tab) => openSettings(tab));
  ipcMain.on('app:quit', () => app.quit());
}

/* ---------- ciclo de vida ---------- */

// Uso em desenvolvimento: salva imagens das janelas com dados de exemplo e encerra.
async function devShots() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // Arrastar nao pode mudar o tamanho da janela, mesmo com escala de tela.
  const before = overlay.getBounds();
  for (let i = 0; i < 300; i++) moveOverlay(i % 2 ? 3 : -2, 1);
  moveOverlay(-150, -300);
  const after = overlay.getBounds();
  console.log('[arraste] escala', screen.getPrimaryDisplay().scaleFactor, 'antes', before.width, before.height, 'depois', after.width, after.height);
  openSettings(process.env.ASIDE_SHOT_TAB || undefined);
  const [shotWidth, shotHeight] = String(process.env.ASIDE_SHOT_SIZE || '').split('x').map(Number);
  if (shotWidth && shotHeight) settingsWin.setContentSize(shotWidth, shotHeight);
  if (process.env.ASIDE_SHOT_EVAL) {
    await new Promise((r) => setTimeout(r, 1200));
    await settingsWin.webContents.executeJavaScript(process.env.ASIDE_SHOT_EVAL, true);
  }
  await new Promise((r) => setTimeout(r, 1800));
  broadcast('session', { active: true, id: 0, startedAt: Date.now() });
  broadcast('transcript', { speaker: 'them', text: 'Qual prazo a gente consegue para a entrega da API?', ts: Date.now() });
  broadcast('transcript', { speaker: 'me', text: 'Deixa eu conferir o que falta no backlog.', ts: Date.now() });
  broadcast('answer:start', { id: 1, question: 'O que vem agora?' });
  broadcast('answer:delta', {
    id: 1,
    text: '## Prazo da API\n\nFaltam **3 itens** no backlog:\n\n- autenticação\n- paginação\n- testes de carga\n\n```js\nconst prazo = estimar(backlog);\n```\n\nSugestão: propor `duas semanas` com revisão na sexta.',
  });
  broadcast('answer:end', { id: 1 });
  await new Promise((r) => setTimeout(r, 700));
  const audioCheck = await overlay.webContents.executeJavaScript(
    `(() => { let err = []; return window.asideAudio.start({ mic: true, system: true, speakerMode: false,
      onSegment() {}, onLevel() {}, onError(m) { err.push(m); } })
      .then((r) => JSON.stringify({ sources: r, err }), (e) => 'FALHOU: ' + e.message)
      .finally(() => window.asideAudio.stop()); })()`,
    true
  );
  console.log('[audio]', audioCheck);
  for (const [name, win] of [['overlay', overlay], ['settings', settingsWin]]) {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), image.toPNG());
  }
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (overlay) overlay.showInactive();
    openSettings();
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('aside');
    db.open();
    db.closeDangling();
    local.init({
      getSettings: () => settings.load(),
      onChange: (state) => {
        broadcast('local', state);
        // Instalar um motor ou baixar um modelo pode deixar o app pronto: avisa as janelas.
        const ready = aiReady();
        if (ready !== lastReady) {
          lastReady = ready;
          broadcast('settings', viewSettings());
        }
      },
    });
    mcp.init({
      confirm: confirmTool,
      onChange: (state) => settingsWin && !settingsWin.isDestroyed() && settingsWin.webContents.send('mcp', state),
    });
    mcp.sync(settings.getMcpServers());

    // Audio do sistema: getDisplayMedia entrega o loopback sem abrir seletor.
    electronSession.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
        .catch(() => callback({}));
    });

    registerIpc();
    createOverlay();
    buildTray();
    registerShortcuts();
    applyStealth();

    if (process.env.ASIDE_CTX_TEST) {
      require('./dev')
        .contextTest({ extractFile, dir: process.env.ASIDE_CTX_TEST })
        .finally(() => app.quit());
    } else if (process.env.ASIDE_MCP_TEST) {
      require('./dev')
        .mcpTest({ mcp, openrouter })
        .finally(() => app.quit());
    } else if (process.env.ASIDE_LOCAL_TEST) {
      require('./dev')
        .localTest({ local, settings, openrouter, wavPath: process.env.ASIDE_LOCAL_TEST })
        .finally(() => app.quit());
    } else if (SHOT_DIR) devShots().catch((error) => {
      console.error(error);
      app.exit(1);
    });
    else openSettings();
  });

  // O app continua na bandeja quando as janelas fecham.
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    local.stopAll();
    mcp.closeAll();
    if (live.id) db.endSession(live.id);
  });
}
