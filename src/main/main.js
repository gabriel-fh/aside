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
const { readScreenText } = require('./ocr');
const {
  SPEAKER_LABEL,
  activeJob,
  buildBriefMessages,
  buildChatMessages,
  buildSummaryMessages,
  briefSlot,
  contextKey,
  needsBrief,
} = require('./prompts');

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
// Transcricoes em andamento: "Responder" espera por elas para nao perder o fim da pergunta.
const pendingSegments = new Set();
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
    // Passa pela barra flutuante: ela corta a fala em andamento antes de perguntar.
    ask: () => (overlay ? overlay.webContents.send('cmd', { type: 'answer-now' }) : ask({ answerNow: true })),
    screen: () => ask({ withScreen: true }),
    region: () => askRegion(''),
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
  ensureBrief();
  buildTray();
  broadcast('settings', next);
  return next;
}

/* ---------- captura de tela ---------- */

// Modelos que recusaram imagem nesta execucao: para eles a tela vai como texto lido por OCR.
const noVision = new Set();

// O modelo consegue ler imagem? Sem informacao, tenta: se o provedor recusar, cai para o OCR.
async function seesImages(target) {
  if (target.local || noVision.has(target.model)) return false;
  if (settings.load().chatProvider !== 'openrouter') return true;
  try {
    const model = (await openrouter.listModels()).find((m) => m.id === target.model);
    return model ? model.input.includes('image') : true;
  } catch {
    return true;
  }
}

const overlayDisplay = () =>
  overlay ? screen.getDisplayMatching(overlay.getBounds()) : screen.getPrimaryDisplay();

// Captura a tela onde a barra esta, na resolucao real, que deixa letra pequena legivel.
async function grabScreen() {
  const display = overlayDisplay();
  const width = Math.min(3840, Math.round(display.size.width * display.scaleFactor));
  const height = Math.round((width * display.size.height) / display.size.width);
  // O overlay fica fora da imagem enviada ao modelo.
  const stealth = Boolean(settings.load().stealth);
  if (overlay && !stealth) overlay.setContentProtection(true);
  try {
    if (!stealth) await new Promise((r) => setTimeout(r, 80));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!source) throw new Error('Nenhuma tela disponível para captura.');
    return source.thumbnail;
  } finally {
    if (overlay && !overlay.isDestroyed() && !stealth) overlay.setContentProtection(false);
  }
}

// Imagem para o modelo: no maximo 1600 px de largura, em JPEG.
function shotToDataUrl(image) {
  const { width } = image.getSize();
  const sized = width > 1600 ? image.resize({ width: 1600, quality: 'best' }) : image;
  return `data:image/jpeg;base64,${sized.toJPEG(80).toString('base64')}`;
}

// Imagem para o OCR: recortes pequenos sao ampliados, o que melhora a leitura.
function shotToPng(image) {
  const { width } = image.getSize();
  const sized = width < 900 ? image.resize({ width: width * 2, quality: 'best' }) : image;
  return sized.toPNG();
}

/* ---------- captura livre: escolher um trecho da tela ---------- */

let regionWin = null;

// Congela a tela, deixa o usuario arrastar um retangulo e devolve so aquele trecho.
async function pickRegion() {
  if (regionWin) return null;
  const display = overlayDisplay();
  const full = await grabScreen();
  const scale = full.getSize().width / display.size.width;

  return new Promise((resolve) => {
    let done = false;
    const finish = (image) => {
      if (done) return;
      done = true;
      ipcMain.removeListener('region:done', onDone);
      if (regionWin && !regionWin.isDestroyed()) regionWin.destroy();
      regionWin = null;
      resolve(image);
    };
    const onDone = (_event, rect) => {
      if (!rect || rect.width < 8 || rect.height < 8) return finish(null);
      const size = full.getSize();
      const x = Math.max(0, Math.round(rect.x * scale));
      const y = Math.max(0, Math.round(rect.y * scale));
      finish(
        full.crop({
          x,
          y,
          width: Math.min(size.width - x, Math.round(rect.width * scale)),
          height: Math.min(size.height - y, Math.round(rect.height * scale)),
        })
      );
    };

    regionWin = new BrowserWindow({
      ...display.bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true },
    });
    regionWin.setAlwaysOnTop(true, 'screen-saver');
    if (settings.load().stealth) regionWin.setContentProtection(true);
    regionWin.loadFile(path.join(ROOT, 'src', 'renderer', 'region.html'));
    regionWin.once('ready-to-show', () => {
      regionWin.show();
      regionWin.focus();
    });
    regionWin.on('closed', () => finish(null));
    regionWin.on('blur', () => finish(null));
    ipcMain.on('region:done', onDone);
  });
}

async function askRegion(text) {
  try {
    const shot = await pickRegion();
    if (shot) await ask({ text, withScreen: true, shot });
  } catch (error) {
    status('error', error.message);
  }
}

/* ---------- perguntas ao modelo ---------- */

// Desafio em andamento: o enunciado e o que ja foi entregue, para seguir um passo por vez.
let task = null;
// Ultima resposta dada, para poder continuar de onde parou quando ela e cortada.
let lastAnswer = null;

const taskState = () => ({ active: Boolean(task), steps: task ? task.answers.length : 0 });

function clearTask() {
  task = null;
  broadcast('task', taskState());
}

// O que o modelo precisa saber do desafio para entregar o passo seguinte.
function taskContext() {
  if (!task) return '';
  const parts = [
    task.statement
      ? `Desafio fixado (enunciado lido da tela):\n${task.statement.slice(0, 3500)}`
      : 'Desafio fixado: o enunciado estava em uma imagem. O plano abaixo descreve o que foi pedido.',
  ];
  const [first, ...rest] = task.answers;
  if (first) parts.push(`Plano e primeiro passo, já entregues:\n${first.slice(0, 2600)}`);
  if (rest.length > 2) parts.push(`(${rest.length - 2} passos intermediários já foram entregues e não aparecem aqui.)`);
  rest.slice(-2).forEach((answer, index, list) => {
    const number = task.answers.length - list.length + index + 1;
    parts.push(`Passo ${number}, já entregue:\n${answer.slice(0, 2000)}`);
  });
  return parts.join('\n\n');
}

const REQUESTS = {
  answerNow:
    'Responda agora à última pergunta ou fala de Eles. Comece pela resposta que eu posso dizer em voz alta, em 1 a 3 frases, na primeira pessoa. Só depois, se ajudar, acrescente detalhes curtos. Se pediram código, entregue o trecho completo.',
  general: 'Com base na conversa até aqui, o que é mais útil eu saber ou dizer agora?',
  screen: [
    'Analise o que está na tela.',
    'Se for uma pergunta ou algo pequeno, responda direto.',
    'Se for um exercício ou desafio de código:',
    '1. Diga em 1 ou 2 linhas o que está sendo pedido e o que vale confirmar com o entrevistador.',
    '2. Se a solução couber em cerca de 40 linhas, entregue-a completa, com 1 frase do que dizer em voz alta.',
    '3. Se for maior, não escreva tudo de uma vez: liste um plano numerado de passos pequenos e entregue só o código do passo 1. Termine com a linha "Próximo: passo 2, <o que é>".',
  ].join('\n'),
  next: [
    'Siga o desafio fixado. Entregue somente o próximo passo do plano que ainda não foi entregue.',
    'Mostre o código só desse passo e diga onde ele encaixa no que já existe. Acrescente 1 frase do que dizer em voz alta.',
    'Não repita código de passos anteriores.',
    'Termine com "Próximo: passo N, <o que é>". Se o plano acabou, escreva "Desafio concluído" e cite 2 casos de borda e como testar.',
  ].join('\n'),
  explain:
    'Explique o último passo entregue do desafio fixado, do jeito que eu explicaria ao entrevistador: o que o código faz, por que essa escolha e uma alternativa. Curto, sem repetir o código inteiro.',
  check: [
    'O texto da tela é o meu código atual no desafio fixado.',
    'Compare com o plano. Aponte erros objetivos, com o trecho exato e a correção.',
    'Se estiver certo, diga isso em 1 frase. Em qualquer caso, diga qual é o próximo ajuste.',
  ].join('\n'),
  cont: 'Continue exatamente de onde a sua resposta anterior parou, sem repetir nada do que já foi escrito e sem introdução. Se parou no meio de um bloco de código, abra o bloco de novo com a mesma linguagem e continue da linha seguinte.',
};

async function ask({
  text = '',
  withScreen = false,
  auto = false,
  answerNow = false,
  shot = null,
  step = null,
  cont = false,
} = {}) {
  // `step` segue um desafio fixado: 'next', 'explain' ou 'check'. `cont` continua a ultima resposta.
  if (step && !task) return status('error', 'Não há desafio em andamento. Use Tela ou Recorte no enunciado.');
  if (cont && !lastAnswer) return status('error', 'Não há resposta para continuar.');
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
  const request = cont
    ? REQUESTS.cont
    : step
      ? REQUESTS[step]
      : typed || (withScreen ? REQUESTS.screen : answerNow ? REQUESTS.answerNow : REQUESTS.general);
  const STEP_LABEL = { next: 'Próximo passo', explain: 'Explicação do passo', check: 'Conferência do meu código' };
  const label = cont
    ? lastAnswer.label
    : step
      ? STEP_LABEL[step]
      : typed ||
        (withScreen ? (shot ? 'Análise do recorte' : 'Análise da tela') : answerNow ? 'Responder agora' : 'O que vem agora?');
  const assistant = s.assistants.find((a) => a.id === s.activeAssistantId) || s.assistants[0];
  // Um pedido novo sobre a tela vira o desafio fixado. Os passos seguintes continuam esse desafio.
  const startsTask = withScreen && !step && !cont;
  const inTask = Boolean(step) || (cont && lastAnswer.inTask);

  if (overlay && !overlay.isVisible() && !auto) overlay.showInactive();
  broadcast('answer:start', { id, question: label, auto, append: cont });

  let full = '';
  try {
    // Espera o fim da pergunta terminar de ser transcrito, com teto para nao travar.
    if (pendingSegments.size) {
      await Promise.race([Promise.allSettled([...pendingSegments]), new Promise((r) => setTimeout(r, 8000))]);
      if (controller.signal.aborted) throw new Error('Cancelado.');
    }
    const target = await chatTarget();
    // Ferramentas so em perguntas feitas pelo usuario e com modelo na nuvem.
    const tools = auto || target.local ? [] : mcp.toolsForModel();
    let streamed = false;
    let screenImage = null;
    let usedScreenText = '';
    const compact = Boolean(s.economy) && !target.local;
    // Teto de saida no modo economico: folgado para codigo, curto para fala.
    const maxTokens = !compact ? undefined : withScreen || inTask || cont ? 2200 : 1100;
    // Para continuar, o modelo precisa do fim do que ja escreveu, sem cortes.
    const turns = cont
      ? [{ q: lastAnswer.request.slice(0, 500), a: lastAnswer.text.slice(-2600) }]
      : inTask || startsTask
        ? []
        : live.turns;

    // A tela vai como imagem quando o modelo enxerga, ou como texto lido por OCR quando nao.
    const run = async (useImage) => {
      let imageDataUrl = null;
      let screenText = '';
      if (withScreen && !screenImage) screenImage = shot || (await grabScreen());
      if (withScreen && useImage) imageDataUrl = shotToDataUrl(screenImage);
      else if (withScreen) {
        screenText = await readScreenText(shotToPng(screenImage));
        if (!screenText) throw new Error('Não encontrei texto nesse trecho da tela.');
      }
      usedScreenText = screenText;
      const messages = buildChatMessages({
        assistant,
        responseLanguage: s.responseLanguage,
        lines: inTask ? live.lines.slice(-6) : live.lines,
        turns,
        rawTurns: cont,
        taskText: inTask ? taskContext() : '',
        request,
        imageDataUrl,
        screenText,
        contextLimit: target.local ? 12000 : compact ? 9000 : 120000,
        compact,
      });
      return openrouter.runChat({
        ...target,
        messages: imageDataUrl ? messages : textOnly(messages),
        maxTokens,
        tools,
        signal: controller.signal,
        onDelta: (delta) => {
          streamed = true;
          broadcast('answer:delta', { id, text: delta });
        },
        callTool: (name, args) => mcp.call(name, args),
        onTool: (name) => status('info', `Usando ferramenta: ${mcp.label(name)}`),
      });
    };

    // Limite por minuto do servico: espera o prazo que ele informa e tenta mais uma vez.
    const attempt = async (useImage) => {
      try {
        return await run(useImage);
      } catch (error) {
        const wait = openrouter.rateLimitWait(error);
        if (wait === null || streamed || controller.signal.aborted) throw error;
        status('info', `Limite por minuto do serviço atingido. Tentando de novo em ${Math.ceil(wait)} s.`);
        await new Promise((r) => setTimeout(r, wait * 1000 + 400));
        if (controller.signal.aborted) throw error;
        return run(useImage);
      }
    };

    const withImage = withScreen && (await seesImages(target));
    let result;
    try {
      result = await attempt(withImage);
    } catch (error) {
      // Provedor recusou a imagem antes de responder: refaz com o texto da tela.
      const refused = withImage && !streamed && !controller.signal.aborted && !/\b429\b/.test(error.message);
      if (!refused) throw error;
      noVision.add(target.model);
      status('info', 'Este modelo não lê imagens: usando o texto da tela.');
      result = await attempt(false);
    }
    full = result.text;

    if (cont) {
      // A continuacao emenda na resposta anterior, inclusive dentro do desafio.
      lastAnswer.text += full;
      if (lastAnswer.inTask && task && task.answers.length) task.answers[task.answers.length - 1] = lastAnswer.text;
    } else {
      if (startsTask) task = { statement: usedScreenText, answers: [full] };
      else if (step === 'next') task.answers.push(full);
      else if (!inTask) {
        live.turns.push({ q: request, a: full });
        if (live.turns.length > 20) live.turns.shift();
      }
      // Explicar e conferir nao avancam o plano: continuar essas respostas nao mexe no desafio.
      lastAnswer = { request, label, text: full, inTask: startsTask || step === 'next' };
    }
    db.addEntry(live.id, { kind: 'question', text: cont ? `${label} (continuação)` : label });
    db.addEntry(live.id, { kind: 'answer', text: full });
    broadcast('answer:end', { id, truncated: result.truncated });
    broadcast('task', taskState());
  } catch (error) {
    const aborted = controller.signal.aborted;
    broadcast('answer:end', { id, error: aborted ? null : error.message, aborted });
  } finally {
    if (currentAsk === controller) currentAsk = null;
  }
}

/* ---------- ficha resumida da vaga ---------- */

let briefBusy = false;
let briefRetry = null;

// Material de apoio longo (curriculo, vaga, arquivos) e condensado uma unica vez.
// Assim cada pergunta leva uma ficha curta, e nao o material inteiro.
async function ensureBrief() {
  const s = settings.load();
  if (briefBusy || !s.economy) return;
  const mode = s.assistants.find((a) => a.id === s.activeAssistantId);
  if (!needsBrief(mode)) return;
  briefBusy = true;
  clearTimeout(briefRetry);
  const key = contextKey(mode);
  const slot = briefSlot(mode);
  const job = activeJob(mode);
  try {
    const target = await chatTarget();
    const text = (await openrouter.complete({ ...target, messages: buildBriefMessages(mode), maxTokens: 650 })).trim();
    if (!text) throw new Error('O modelo devolveu uma ficha vazia.');
    // Grava no modo certo, mesmo que as configuracoes tenham mudado no meio do caminho.
    const assistants = settings.load().assistants.map((a) =>
      a.id === mode.id ? { ...a, briefs: { ...(a.briefs || {}), [slot]: { key, text } } } : a
    );
    settings.update({ assistants });
    broadcast('settings', viewSettings());
    status('info', `Ficha resumida de "${job ? job.title : mode.name}" pronta: as perguntas ficam mais leves.`);
  } catch (error) {
    // Sem ficha o app segue funcionando com o material cortado. Tenta de novo mais tarde.
    const wait = openrouter.rateLimitWait(error);
    briefRetry = setTimeout(ensureBrief, (wait === null ? 90 : wait + 2) * 1000);
  } finally {
    briefBusy = false;
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
  }, 500);
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
  // So a janela principal recebe as chaves, para mostrar, copiar e editar no campo.
  ipcMain.handle('keys:get', (event) => {
    if (!settingsWin || event.sender !== settingsWin.webContents) return { openrouter: '', custom: '' };
    return { openrouter: settings.getApiKey(), custom: settings.getCustomKey() };
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
    const job = handleSegment(segment || {});
    pendingSegments.add(job);
    job.finally(() => pendingSegments.delete(job));
  });
  ipcMain.handle('audio:desktop-source', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    return sources[0] ? sources[0].id : null;
  });

  ipcMain.handle('ask', (_e, request) => {
    ask(request || {});
  });
  ipcMain.handle('ask:region', (_e, text) => {
    askRegion(String(text || ''));
  });
  // Durante um desafio: recorta o codigo atual do usuario e pede a conferencia.
  ipcMain.handle('ask:check', () => {
    if (!task) return status('error', 'Não há desafio em andamento.');
    pickRegion()
      .then((shot) => shot && ask({ step: 'check', withScreen: true, shot }))
      .catch((error) => status('error', error.message));
    return undefined;
  });
  ipcMain.handle('task:get', () => taskState());
  ipcMain.handle('task:clear', () => clearTask());
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
  // Captura livre: abre a selecao, confirma um retangulo por codigo e le o recorte por OCR.
  try {
    const picking = pickRegion();
    await new Promise((r) => setTimeout(r, 900));
    const view = await regionWin.webContents.capturePage();
    fs.writeFileSync(path.join(SHOT_DIR, 'region.png'), view.toPNG());
    await regionWin.webContents.executeJavaScript('window.aside.regionDone({ x: 0, y: 0, width: 700, height: 260 }); 1');
    const crop = await picking;
    fs.writeFileSync(path.join(SHOT_DIR, 'recorte.png'), crop.toPNG());
    const started = Date.now();
    const text = await readScreenText(shotToPng(crop));
    const size = crop.getSize();
    console.log(`[recorte] ${size.width}x${size.height}, OCR em ${Date.now() - started} ms:`, JSON.stringify(text.slice(0, 160)));
  } catch (error) {
    console.log('[recorte] FALHOU:', error.message);
  }
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
    setTimeout(ensureBrief, 4000);

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
