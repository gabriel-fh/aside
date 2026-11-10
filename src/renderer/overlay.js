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
    askBtn: $('askBtn'),
    screenBtn: $('screenBtn'),
    trBtn: $('trBtn'),
    cfgBtn: $('cfgBtn'),
    hideBtn: $('hideBtn'),
    status: $('status'),
    question: $('question'),
    answer: $('answer'),
    transcript: $('transcript'),
    form: $('form'),
    q: $('q'),
    stopBtn: $('stopBtn'),
  };

  let settings = null;
  let active = false;
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

  let last = null;
  el.drag.addEventListener('pointerdown', (event) => {
    dragging = true;
    last = { x: event.screenX, y: event.screenY };
    el.drag.setPointerCapture(event.pointerId);
    el.drag.classList.add('dragging');
  });
  el.drag.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    api.moveBy(event.screenX - last.x, event.screenY - last.y);
    last = { x: event.screenX, y: event.screenY };
  });
  const endDrag = () => {
    dragging = false;
    el.drag.classList.remove('dragging');
  };
  el.drag.addEventListener('pointerup', endDrag);
  el.drag.addEventListener('pointercancel', endDrag);

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
  }

  function applySession(state) {
    active = Boolean(state.active);
    el.rec.classList.toggle('live', active);
    el.recLabel.textContent = active ? 'Parar' : 'Iniciar';
    if (!active) {
      el.mMe.style.width = '0';
      el.mThem.style.width = '0';
    }
  }

  /* ---------- sessao ---------- */

  async function startSession() {
    if (active || busy) return;
    busy = true;
    try {
      if (!settings.hasKey) {
        showStatus('Informe a chave do OpenRouter em Ajustes.');
        api.openSettings('geral');
        return;
      }
      el.transcript.replaceChildren();
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

  el.trBtn.addEventListener('click', () => {
    el.transcript.hidden = !el.transcript.hidden;
    el.trBtn.classList.toggle('on', !el.transcript.hidden);
    el.transcript.scrollTop = el.transcript.scrollHeight;
  });

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

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = el.q.value.trim();
    el.q.value = '';
    api.ask({ text });
  });
  el.askBtn.addEventListener('click', () => api.ask({ text: el.q.value.trim() }));
  el.screenBtn.addEventListener('click', () => {
    const text = el.q.value.trim();
    el.q.value = '';
    api.ask({ text, withScreen: true });
  });
  el.stopBtn.addEventListener('click', () => api.cancelAsk());

  /* ---------- barra ---------- */

  el.assistant.addEventListener('change', () => api.setSettings({ activeAssistantId: el.assistant.value }));
  el.cfgBtn.addEventListener('click', () => api.openSettings());
  el.hideBtn.addEventListener('click', () => api.hideOverlay());

  api.on('settings', applySettings);
  api.on('session', applySession);
  api.on('transcript', addLine);
  api.on('status', ({ kind, message }) => showStatus(message, kind));
  api.on('cmd', (cmd) => {
    if (cmd.type === 'toggle-session') (active ? stopSession : startSession)();
  });

  api.getSettings().then(applySettings);
  api.getSession().then(applySession);
})();
