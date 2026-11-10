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
  }
  el.tabAnswer.addEventListener('click', () => showView('answer'));
  el.tabTranscript.addEventListener('click', () => showView('transcript'));

  function setFolded(folded) {
    el.root.classList.toggle('folded', folded);
    try {
      localStorage.setItem('folded', folded ? '1' : '');
    } catch {
      // sem armazenamento, o estado vale so para esta execucao
    }
  }
  el.foldBtn.addEventListener('click', () => setFolded(!el.root.classList.contains('folded')));

  /* ---------- sessao ---------- */

  async function startSession() {
    if (active || busy) return;
    busy = true;
    try {
      if (!settings.ready) {
        showStatus('Antes, conecte uma inteligência artificial.');
        api.openSettings('geral');
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

  api.on('answer:start', ({ id, question }) => {
    answerId = id;
    answerText = '';
    el.question.textContent = question;
    el.question.hidden = false;
    el.answer.innerHTML = '<p class="hint">Pensando...</p>';
    el.stopBtn.hidden = false;
    setFolded(false);
    showView('answer');
  });
  api.on('answer:delta', ({ id, text }) => {
    if (id !== answerId) return;
    answerText += text;
    if (!renderQueued) {
      renderQueued = true;
      requestAnimationFrame(renderAnswer);
    }
  });
  api.on('answer:end', ({ id, error, aborted }) => {
    if (id !== answerId) return;
    el.stopBtn.hidden = true;
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
  document.getElementById('setupBtn').addEventListener('click', () => api.openSettings('geral'));
  el.hideBtn.addEventListener('click', () => api.hideOverlay());

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
  try {
    if (localStorage.getItem('folded')) el.root.classList.add('folded');
  } catch {
    // segue expandido
  }
  api.getSettings().then(applySettings);
  api.getSession().then(applySession);
})();
