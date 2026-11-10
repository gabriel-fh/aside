(function () {
  const api = window.aside;
  const $ = (id) => document.getElementById(id);
  let settings = null;
  let models = [];

  /* ---------- avisos ---------- */

  let toastTimer = null;
  function toast(message, isError) {
    const node = $('toast');
    node.textContent = message;
    node.className = isError ? 'error' : '';
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.hidden = true;
    }, 6000);
  }

  async function guard(fn) {
    try {
      return await fn();
    } catch (error) {
      toast(String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
      return undefined;
    }
  }

  /* ---------- abas ---------- */

  function showTab(name) {
    for (const button of document.querySelectorAll('.tab')) button.classList.toggle('on', button.dataset.tab === name);
    for (const page of document.querySelectorAll('.page')) page.hidden = page.id !== `tab-${name}`;
    if (name === 'historico') loadHistory();
  }
  for (const button of document.querySelectorAll('.tab')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }

  /* ---------- geral ---------- */

  const TEXT_FIELDS = ['chatModel', 'transcribeModel', 'language', 'responseLanguage', 'translateTo', 'obsidianVault'];
  const CHECK_FIELDS = ['captureMic', 'captureSystem', 'speakerMode', 'autoInsights', 'autoSummary', 'stealth'];

  function modelInfo(id, needsAudio) {
    if (!models.length) return '';
    const model = models.find((m) => m.id === id);
    if (!model) return 'Modelo não encontrado na lista do OpenRouter.';
    if (needsAudio && !model.input.includes('audio')) return 'Este modelo não aceita áudio: a transcrição vai falhar.';
    const price = `US$ ${model.promptPrice.toFixed(2)} entrada e US$ ${model.completionPrice.toFixed(2)} saída por milhão de tokens`;
    return `${model.name}. ${price}.`;
  }

  function refreshModelInfo() {
    $('chatModelInfo').textContent = modelInfo($('chatModel').value.trim(), false);
    $('transcribeModelInfo').textContent = modelInfo($('transcribeModel').value.trim(), true);
  }

  function fillGeneral() {
    for (const id of TEXT_FIELDS) if (document.activeElement !== $(id)) $(id).value = settings[id] || '';
    for (const id of CHECK_FIELDS) $(id).checked = Boolean(settings[id]);
    $('opacity').value = settings.opacity;
    $('keyState').textContent = settings.hasKey ? '(salva)' : '';
    refreshModelInfo();
  }

  for (const id of TEXT_FIELDS) {
    $(id).addEventListener('change', () => guard(() => api.setSettings({ [id]: $(id).value.trim() })));
  }
  for (const id of CHECK_FIELDS) {
    $(id).addEventListener('change', () => guard(() => api.setSettings({ [id]: $(id).checked })));
  }
  $('opacity').addEventListener('input', () => api.setSettings({ opacity: Number($('opacity').value) }));

  $('saveKey').addEventListener('click', () =>
    guard(async () => {
      const key = $('apiKey').value.trim();
      if (!key) return toast('Cole a chave antes de salvar.', true);
      await api.setApiKey(key);
      $('apiKey').value = '';
      toast('Chave salva.');
    })
  );
  $('clearKey').addEventListener('click', () =>
    guard(async () => {
      await api.setApiKey('');
      toast('Chave removida.');
    })
  );
  $('pickVault').addEventListener('click', () =>
    guard(async () => {
      const folder = await api.pickFolder();
      if (folder) await api.setSettings({ obsidianVault: folder });
    })
  );

  async function loadModels() {
    const list = await guard(() => api.listModels());
    if (!list) return;
    models = list;
    const option = (m) => {
      const node = document.createElement('option');
      node.value = m.id;
      node.label = m.name;
      return node;
    };
    $('allModels').replaceChildren(...models.map(option));
    $('audioModels').replaceChildren(...models.filter((m) => m.input.includes('audio')).map(option));
    refreshModelInfo();
  }

  /* ---------- assistentes ---------- */

  let selectedAssistant = null;

  function renderAssistants() {
    if (!settings.assistants.some((a) => a.id === selectedAssistant)) {
      selectedAssistant = settings.activeAssistantId;
    }
    $('assistantList').replaceChildren(
      ...settings.assistants.map((a) => {
        const button = document.createElement('button');
        button.className = `item${a.id === selectedAssistant ? ' on' : ''}`;
        const name = document.createElement('strong');
        name.textContent = a.name;
        const note = document.createElement('span');
        note.textContent = a.id === settings.activeAssistantId ? 'Em uso' : ' ';
        button.append(name, note);
        button.addEventListener('click', () => {
          selectedAssistant = a.id;
          renderAssistants();
        });
        return button;
      })
    );
    const current = settings.assistants.find((a) => a.id === selectedAssistant);
    if (current && document.activeElement !== $('aName') && document.activeElement !== $('aPrompt')) {
      $('aName').value = current.name;
      $('aPrompt').value = current.prompt;
    }
  }

  $('newAssistant').addEventListener('click', () =>
    guard(async () => {
      const id = `a${Date.now().toString(36)}`;
      selectedAssistant = id;
      await api.setSettings({ assistants: [...settings.assistants, { id, name: 'Novo assistente', prompt: '' }] });
      $('aName').focus();
      $('aName').select();
    })
  );
  $('aSave').addEventListener('click', () =>
    guard(async () => {
      const name = $('aName').value.trim() || 'Sem nome';
      const prompt = $('aPrompt').value.trim();
      const assistants = settings.assistants.map((a) => (a.id === selectedAssistant ? { ...a, name, prompt } : a));
      await api.setSettings({ assistants });
      toast('Assistente salvo.');
    })
  );
  $('aUse').addEventListener('click', () => guard(() => api.setSettings({ activeAssistantId: selectedAssistant })));
  $('aDelete').addEventListener('click', () =>
    guard(async () => {
      if (settings.assistants.length <= 1) return toast('Mantenha pelo menos um assistente.', true);
      const assistants = settings.assistants.filter((a) => a.id !== selectedAssistant);
      const patch = { assistants };
      if (settings.activeAssistantId === selectedAssistant) patch.activeAssistantId = assistants[0].id;
      selectedAssistant = null;
      await api.setSettings(patch);
    })
  );

  /* ---------- historico ---------- */

  let selectedSession = null;
  const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

  function duration(session) {
    if (!session.ended_at) return 'em andamento';
    const minutes = Math.max(1, Math.round((session.ended_at - session.started_at) / 60000));
    return `${minutes} min`;
  }

  async function loadHistory() {
    const rows = await guard(() => api.historyList($('hSearch').value));
    if (!rows) return;
    $('historyList').replaceChildren(
      ...rows.map((s) => {
        const button = document.createElement('button');
        button.className = `item${s.id === selectedSession ? ' on' : ''}`;
        const title = document.createElement('strong');
        title.textContent = s.title || 'Sessão sem título';
        const meta = document.createElement('span');
        meta.textContent = `${dateFormat.format(new Date(s.started_at))}, ${duration(s)}, ${s.entry_count} itens`;
        button.append(title, meta);
        button.addEventListener('click', () => openSession(s.id));
        return button;
      })
    );
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = $('hSearch').value ? 'Nada encontrado.' : 'Nenhuma sessão gravada ainda.';
      $('historyList').append(empty);
    }
  }

  async function openSession(id) {
    const data = await guard(() => api.historyGet(id));
    if (!data) return;
    selectedSession = id;
    $('hEmpty').hidden = true;
    $('hDetail').hidden = false;
    $('hTitle').textContent = data.session.title || 'Sessão sem título';
    $('hMeta').textContent = `${dateFormat.format(new Date(data.session.started_at))}, ${duration(data.session)}`;
    $('hSummary').innerHTML = data.session.summary ? window.renderMarkdown(data.session.summary) : '';
    $('hEntries').replaceChildren(
      ...data.entries.map((e) => {
        const row = document.createElement('div');
        if (e.kind === 'transcript') {
          row.className = `entry ${e.speaker}`;
          const who = document.createElement('span');
          who.className = 'who';
          who.textContent = e.speaker === 'me' ? 'Eu' : 'Eles';
          row.append(who, document.createTextNode(e.text));
          if (e.extra) {
            const tr = document.createElement('span');
            tr.className = 'tr';
            tr.textContent = e.extra;
            row.append(tr);
          }
        } else if (e.kind === 'question') {
          row.className = 'entry question';
          row.textContent = e.text;
        } else {
          row.className = 'entry answer md';
          row.innerHTML = window.renderMarkdown(e.text);
        }
        return row;
      })
    );
    loadHistory();
  }

  let searchTimer = null;
  $('hSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadHistory, 200);
  });
  $('hSummarize').addEventListener('click', () =>
    guard(async () => {
      toast('Gerando resumo...');
      await api.historySummarize(selectedSession);
      await openSession(selectedSession);
    })
  );
  $('hExport').addEventListener('click', () =>
    guard(async () => {
      const target = await api.historyExport(selectedSession);
      if (target) toast(`Exportado para ${target}`);
    })
  );
  $('hDelete').addEventListener('click', () =>
    guard(async () => {
      if (!confirm('Excluir esta sessão? Não dá para desfazer.')) return;
      await api.historyDelete(selectedSession);
      selectedSession = null;
      $('hDetail').hidden = true;
      $('hEmpty').hidden = false;
      loadHistory();
    })
  );

  /* ---------- atalhos ---------- */

  const SHORTCUTS = [
    ['toggle', 'Mostrar ou ocultar o overlay'],
    ['session', 'Iniciar ou parar a sessão'],
    ['ask', 'Perguntar com base na conversa'],
    ['screen', 'Analisar a tela'],
    ['up', 'Mover para cima'],
    ['down', 'Mover para baixo'],
    ['left', 'Mover para a esquerda'],
    ['right', 'Mover para a direita'],
  ];

  function renderShortcuts() {
    if ($('shortcutList').contains(document.activeElement)) return;
    $('shortcutList').replaceChildren(
      ...SHORTCUTS.map(([key, label]) => {
        const row = document.createElement('label');
        row.className = 'shortcut';
        const text = document.createElement('span');
        text.textContent = label;
        const input = document.createElement('input');
        input.dataset.key = key;
        input.value = settings.shortcuts[key] || '';
        input.spellcheck = false;
        row.append(text, input);
        return row;
      })
    );
  }

  $('saveShortcuts').addEventListener('click', () =>
    guard(async () => {
      const shortcuts = {};
      for (const input of $('shortcutList').querySelectorAll('input')) shortcuts[input.dataset.key] = input.value.trim();
      await api.setSettings({ shortcuts });
      toast('Atalhos salvos.');
    })
  );

  /* ---------- inicio ---------- */

  function apply(next) {
    settings = next;
    fillGeneral();
    renderAssistants();
    renderShortcuts();
  }

  api.on('settings', apply);
  api.on('status', ({ kind, message }) => toast(message, kind !== 'info'));
  api.on('session', () => {
    if (!$('tab-historico').hidden) loadHistory();
  });
  api.on('cmd', (cmd) => {
    if (cmd.type === 'tab') showTab(cmd.tab);
  });

  api.getSettings().then((next) => {
    apply(next);
    const initial = location.hash.slice(1);
    if (initial) showTab(initial);
    loadModels();
  });
})();
