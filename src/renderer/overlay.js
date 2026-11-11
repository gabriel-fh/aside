(function () {
  const api = window.aside;
  const $ = (id) => document.getElementById(id);
  const el = {
    root: $('root'),
    drag: $('drag'),
    rec: $('rec'),
    recLabel: $('recLabel'),
    mMe: $('mMe'),
    mThem: $('mThem'),
    assistant: $('assistant'),
    screenBtn: $('screenBtn'),
    cfgBtn: $('cfgBtn'),
    foldBtn: $('foldBtn'),
    hideBtn: $('hideBtn'),
    tabAnswer: $('tabAnswer'),
    tabTranscript: $('tabTranscript'),
    ctxBadge: $('ctxBadge'),
    status: $('status'),
    answerView: $('answerView'),
    question: $('question'),
    answer: $('answer'),
    transcript: $('transcript'),
    form: $('form'),
    q: $('q'),
    stopBtn: $('stopBtn'),
  };

  const EMPTY_ANSWER = [
    '<div class="empty"><b>Como usar</b><ol>',
    '<li>Clique em <kbd>Iniciar</kbd> e converse normalmente.</li>',
    '<li>Quando te perguntarem algo, clique em <kbd>Responder</kbd> ou aperte <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Enter</kbd>.</li>',
    '<li>Precisa de algo? Use os botões abaixo ou escreva sua pergunta.</li>',
    '</ol></div>',
  ].join('');
  const LISTENING = '<div class="empty"><b>Ouvindo a conversa</b><span>As sugestões aparecem aqui. Você também pode perguntar a qualquer momento.</span></div>';
  const EMPTY_TRANSCRIPT = '<p class="hint">A transcrição aparece aqui durante a sessão.</p>';

  let settings = null;
  let active = false;
  let startedAt = 0;
  let clock = null;
  let busy = false;
  let answerId = 0;
  let answerText = '';
  let renderQueued = false;
  let statusTimer = null;

  /* ---------- clique atravessa as areas vazias ---------- */

  let ignoring = true;
  let dragging = false;
  function setIgnoring(next) {
    if (dragging) next = false;
    if (next === ignoring) return;
    ignoring = next;
    api.setIgnoreMouse(next);
  }
  document.addEventListener('mousemove', (event) => {
    setIgnoring(!(event.target instanceof Element && event.target.closest('.solid')));
  });
  document.documentElement.addEventListener('mouseleave', () => setIgnoring(true));

  /* ---------- arrastar a janela ---------- */

  // A barra inteira arrasta a janela, menos os controles dela.
  const bar = document.getElementById('bar');
  let last = null;
  bar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button, select, input')) return;
    dragging = true;
    last = { x: event.screenX, y: event.screenY };
    bar.setPointerCapture(event.pointerId);
    bar.classList.add('dragging');
  });
  bar.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.screenX - last.x;
    const dy = event.screenY - last.y;
    if (!dx && !dy) return;
    api.moveBy(dx, dy);
    last = { x: event.screenX, y: event.screenY };
  });
  const endDrag = () => {
    dragging = false;
    bar.classList.remove('dragging');
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);

  /* ---------- estado e configuracoes ---------- */

  function showStatus(message, kind) {
    el.status.textContent = message;
    el.status.className = kind === 'info' ? 'info' : '';
    el.status.hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      el.status.hidden = true;
    }, 7000);
  }

  function applySettings(next) {
    settings = next;
    el.root.style.setProperty('--alpha', String(next.opacity));
    el.assistant.replaceChildren(
      ...next.assistants.map((a) => {
        const option = document.createElement('option');
        option.value = a.id;
        option.textContent = a.name;
        return option;
      })
    );
    el.assistant.value = next.activeAssistantId;
    document.getElementById('setup').hidden = Boolean(next.ready);

    const mode = next.assistants.find((a) => a.id === next.activeAssistantId);
    const files = mode && Array.isArray(mode.files) ? mode.files.length : 0;
    const hasText = Boolean(mode && mode.context && mode.context.trim());
    const parts = [];
    if (hasText) parts.push('anotações');
    if (files) parts.push(files === 1 ? '1 arquivo' : `${files} arquivos`);
    el.ctxBadge.hidden = !parts.length;
    el.ctxBadge.textContent = `Contexto: ${parts.join(' e ')}`;
    const job = mode && mode.interview && Array.isArray(mode.jobs) ? mode.jobs.find((j) => j.id === mode.activeJobId) : null;
    if (job) {
      el.ctxBadge.hidden = false;
      el.ctxBadge.textContent = `Vaga: ${job.title}`;
    }
  }

  function tick() {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    el.recLabel.textContent = `${mm}:${ss}`;
  }

  function applySession(state) {
    active = Boolean(state.active);
    startedAt = state.startedAt || Date.now();
    el.rec.classList.toggle('live', active);
    el.root.classList.toggle('live', active);
    if (!answerText) el.answer.innerHTML = active ? LISTENING : EMPTY_ANSWER;
    clearInterval(clock);
    if (active) {
      tick();
      clock = setInterval(tick, 1000);
    } else {
      el.recLabel.textContent = 'Iniciar';
      el.mMe.style.width = '0';
      el.mThem.style.width = '0';
    }
  }

  /* ---------- painel ---------- */

  function showView(name) {
    const transcript = name === 'transcript';
    el.answerView.hidden = transcript;
    el.transcript.hidden = !transcript;
    el.tabAnswer.classList.toggle('on', !transcript);
    el.tabTranscript.classList.toggle('on', transcript);
    if (transcript) el.transcript.scrollTop = el.transcript.scrollHeight;
    document.getElementById('saveMd').hidden = !transcript;
  }
  document.getElementById('saveMd').addEventListener('click', async () => {
    try {
      showStatus(`Salvo em ${await api.exportQuick()}`, 'info');
    } catch (error) {
      showStatus(String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  });
  el.tabAnswer.addEventListener('click', () => showView('answer'));
  el.tabTranscript.addEventListener('click', () => showView('transcript'));

  function setFolded(folded) {
    el.root.classList.toggle('folded', folded);
  }
  el.foldBtn.addEventListener('click', () => setFolded(!el.root.classList.contains('folded')));

  /* ---------- sessao ---------- */

  async function startSession() {
    if (active || busy) return;
    busy = true;
    try {
      if (!settings.ready) {
        showStatus('Antes, faça a configuração guiada.');
        api.openSettings('guia');
        return;
      }
      el.transcript.innerHTML = EMPTY_TRANSCRIPT;
      await window.asideAudio.start({
        mic: settings.captureMic,
        system: settings.captureSystem,
        speakerMode: settings.speakerMode,
        onSegment: (segment) => api.sendSegment(segment),
        onLevel: (levels) => {
          el.mMe.style.width = `${Math.min(100, levels.me * 900)}%`;
          el.mThem.style.width = `${Math.min(100, levels.them * 900)}%`;
        },
        onError: (message) => showStatus(message),
      });
      applySession(await api.startSession());
    } catch (error) {
      showStatus(error.message);
    } finally {
      busy = false;
    }
  }

  async function stopSession() {
    if (!active || busy) return;
    busy = true;
    try {
      await window.asideAudio.stop();
      applySession(await api.stopSession());
    } finally {
      busy = false;
    }
  }

  el.rec.addEventListener('click', () => (active ? stopSession() : startSession()));

  /* ---------- transcricao ---------- */

  function addLine(line) {
    if (el.transcript.querySelector('.hint')) el.transcript.replaceChildren();
    const row = document.createElement('div');
    row.className = `line ${line.speaker}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = line.speaker === 'me' ? 'Eu' : 'Eles';
    row.append(who, document.createTextNode(line.text));
    if (line.translation) {
      const tr = document.createElement('span');
      tr.className = 'tr';
      tr.textContent = line.translation;
      row.append(tr);
    }
    el.transcript.append(row);
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  /* ---------- respostas ---------- */

  function renderAnswer() {
    renderQueued = false;
    el.answer.innerHTML = window.renderMarkdown(answerText);
    el.answer.scrollTop = el.answer.scrollHeight;
  }

  const contBtn = document.getElementById('contBtn');
  const taskBar = document.getElementById('taskBar');
  const chips = document.getElementById('chips');

  api.on('answer:start', ({ id, question, append }) => {
    answerId = id;
    contBtn.hidden = true;
    el.question.textContent = question;
    el.question.hidden = false;
    if (append && answerText) {
      // Continuacao: mantem o que ja foi escrito. Se parou dentro de um bloco de codigo, fecha o bloco
      // para a continuacao poder reabri-lo.
      const fences = (answerText.match(/^\s*```/gm) || []).length;
      answerText += fences % 2 ? '\n```\n' : '\n';
    } else {
      answerText = '';
      el.answer.innerHTML = '<p class="hint">Pensando...</p>';
    }
    el.stopBtn.hidden = false;
    setFolded(false);
    showView('answer');
  });
  // No modo combinado, mostra quem esta respondendo.
  api.on('answer:meta', ({ id, engine }) => {
    if (id !== answerId) return;
    const base = el.question.textContent.replace(/ ((neste computador|nuvem))$/, '');
    el.question.textContent = `${base} (${engine === 'local' ? 'neste computador' : 'nuvem'})`;
  });
  api.on('answer:delta', ({ id, text }) => {
    if (id !== answerId) return;
    answerText += text;
    if (!renderQueued) {
      renderQueued = true;
      requestAnimationFrame(renderAnswer);
    }
  });
  api.on('answer:end', ({ id, error, aborted, truncated }) => {
    if (id !== answerId) return;
    el.stopBtn.hidden = true;
    // Resposta que bateu no teto de tamanho: oferece continuar de onde parou.
    contBtn.hidden = !truncated;
    if (error) showStatus(error);
    if (!answerText && (error || aborted)) {
      el.answer.innerHTML = '<p class="hint">Sem resposta.</p>';
    }
  });

  // Corta a fala em andamento, manda transcrever e ja pede a resposta.
  function answerNow() {
    if (active) window.asideAudio.flush();
    api.ask({ answerNow: true });
  }
  document.getElementById('answerBtn').addEventListener('click', answerNow);

  contBtn.addEventListener('click', () => api.ask({ cont: true }));

  // Desafio em etapas: com um desafio fixado, os botoes de passo ocupam o lugar dos atalhos comuns.
  function applyTask(state) {
    taskBar.hidden = !state.active;
    chips.hidden = state.active;
    const n = state.steps;
    document.getElementById('taskLabel').textContent =
      `Desafio em etapas: ${n} ${n === 1 ? 'parte entregue' : 'partes entregues'}`;
  }
  for (const button of taskBar.querySelectorAll('[data-step]')) {
    button.addEventListener('click', () => api.ask({ step: button.dataset.step }));
  }
  document.getElementById('taskCheck').addEventListener('click', () => api.askCheck());
  document.getElementById('taskEnd').addEventListener('click', () => api.clearTask());
  api.on('task', applyTask);
  api.getTask().then(applyTask);

  function takeQuestion() {
    const text = el.q.value.trim();
    el.q.value = '';
    return text;
  }

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    api.ask({ text: takeQuestion() });
  });
  el.screenBtn.addEventListener('click', () => api.ask({ text: takeQuestion(), withScreen: true }));
  document.getElementById('regionBtn').addEventListener('click', () => api.askRegion(takeQuestion()));
  el.stopBtn.addEventListener('click', () => api.cancelAsk());
  for (const chip of document.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      if (chip.dataset.screen) api.ask({ text: takeQuestion(), withScreen: true });
      else api.ask({ text: chip.dataset.ask });
    });
  }

  /* ---------- barra ---------- */

  el.assistant.addEventListener('change', () => api.setSettings({ activeAssistantId: el.assistant.value }));
  el.cfgBtn.addEventListener('click', () => api.openSettings());
  document.getElementById('setupBtn').addEventListener('click', () => api.openSettings('guia'));
  el.hideBtn.addEventListener('click', () => api.hideOverlay());

  // Medidor de cota: quanto resta do limite diario de tokens do modelo da nuvem em uso.
  const thousands = (n) => (n >= 1000 ? `${Math.round(n / 1000)} mil` : String(n));
  function applyQuota(state) {
    const box = document.getElementById('quota');
    box.hidden = !state || !state.show || !state.limit;
    if (box.hidden) return;
    const pct = state.spent ? 0 : Math.round((state.left / state.limit) * 100);
    document.getElementById('quotaFill').style.width = `${pct}%`;
    document.getElementById('quotaText').textContent = `${state.onBackup ? 'Cota do modelo reserva' : 'Cota do dia'}: ${pct}%`;
    box.classList.toggle('low', pct <= 25 && pct > 10);
    box.classList.toggle('out', pct <= 10);
    const lines = [
      `Modelo: ${state.model}${state.onBackup ? ' (reserva, o principal esgotou a cota)' : ''}`,
      `Tokens em 24 horas: ${thousands(state.used)} usados de ${thousands(state.limit)}, restam ${thousands(state.left)}`,
    ];
    if (state.daily && state.reqLeft !== null) lines.push(`Pedidos restantes hoje: ${state.reqLeft}`);
    lines.push('A conta considera só o que o Aside gastou.');
    box.title = lines.join('\n');
  }
  api.on('quota', applyQuota);
  api.getQuota().then(applyQuota);

  api.on('settings', applySettings);
  api.on('session', applySession);
  api.on('transcript', addLine);
  api.on('status', ({ kind, message }) => showStatus(message, kind));
  api.on('cmd', (cmd) => {
    if (cmd.type === 'toggle-session') (active ? stopSession : startSession)();
    if (cmd.type === 'answer-now') answerNow();
  });

  el.answer.innerHTML = EMPTY_ANSWER;
  el.transcript.innerHTML = EMPTY_TRANSCRIPT;
  // O app abre so com a barra. O painel aparece quando chega uma resposta ou ao clicar na seta.
  el.root.classList.add('folded');
  api.getSettings().then(applySettings);
  api.getSession().then(applySession);
})();
