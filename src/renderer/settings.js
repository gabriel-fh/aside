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
    if (name === 'local') refreshLocal();
    if (name === 'ferramentas') refreshMcp();
  }
  for (const button of document.querySelectorAll('.tab')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }

  /* ---------- geral ---------- */

  const TEXT_FIELDS = [
    'chatModel',
    'transcribeModel',
    'language',
    'responseLanguage',
    'translateTo',
    'obsidianVault',
    'whisperLang',
    'transcribeProvider',
    'chatProvider',
  ];
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

  /* ---------- local ---------- */

  let localState = null;

  function button(label, onClick, danger) {
    const node = document.createElement('button');
    node.className = `ghost${danger ? ' danger' : ''}`;
    node.textContent = label;
    node.addEventListener('click', () => guard(onClick));
    return node;
  }

  function lrow(title, note, parts) {
    const row = document.createElement('div');
    row.className = 'lrow';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = title;
    if (note) {
      const small = document.createElement('small');
      small.textContent = note;
      name.append(small);
    }
    row.append(name);
    for (const part of parts) {
      if (typeof part === 'string') {
        const state = document.createElement('span');
        state.className = 'state';
        state.textContent = part;
        row.append(state);
      } else if (part) {
        row.append(part);
      }
    }
    return row;
  }

  // Devolve os controles de progresso se o download estiver em andamento.
  function progressParts(id) {
    const d = localState.downloads[id];
    if (!d) return null;
    const text = d.total
      ? `Baixando ${Math.floor((d.received / d.total) * 100)}%`
      : `Baixando ${Math.round(d.received / 1e6)} MB`;
    return [text, button('Cancelar', () => api.localCancel(id))];
  }

  function renderBins(kind, target, settingKey) {
    $(target).replaceChildren(
      ...localState[kind].variants.map((v) => {
        const id = `bin:${kind}:${v.id}`;
        const parts = progressParts(id) || [
          v.installed && v.selected ? 'Em uso' : null,
          v.installed && !v.selected ? button('Usar', () => api.setSettings({ [settingKey]: v.id })) : null,
          button(v.installed ? 'Atualizar' : 'Instalar', async () => {
            await api.localInstall(kind, v.id);
            await api.setSettings({ [settingKey]: v.id });
            toast(`${v.label} instalado.`);
          }),
        ];
        return lrow(v.label, v.version ? `build ${v.version}` : '', parts);
      })
    );
  }

  function renderLocal() {
    if (!localState || !settings) return;
    renderBins('whisper', 'whisperBins', 'whisperVariant');
    renderBins('llama', 'llamaBins', 'llamaVariant');

    $('whisperModels').replaceChildren(
      ...localState.whisper.models.map((m) => {
        const inUse = settings.whisperModel === m.id;
        const parts = progressParts(`whisper:${m.id}`) || [
          m.installed && inUse ? 'Em uso' : null,
          m.installed && !inUse ? button('Usar', () => api.setSettings({ whisperModel: m.id })) : null,
          m.installed
            ? button('Excluir', () => api.localDelete('whisper', m.id), true)
            : button('Baixar', async () => {
                await api.localWhisperModel(m.id);
                await api.setSettings({ whisperModel: m.id });
              }),
        ];
        return lrow(m.id, `${m.mb} MB, ${m.note}`, parts);
      })
    );

    const installed = localState.llama.models;
    const rows = installed.map((m) => {
      const inUse = settings.llamaModel === m.path;
      return lrow(m.name, `${m.mb} MB`, [
        inUse ? 'Em uso' : button('Usar', () => api.setSettings({ llamaModel: m.path })),
        button('Excluir', async () => {
          await api.localDelete('llama', m.name);
          if (inUse) await api.setSettings({ llamaModel: '' });
        }, true),
      ]);
    });
    if (settings.llamaModel && !installed.some((m) => m.path === settings.llamaModel)) {
      rows.push(lrow(settings.llamaModel, 'arquivo externo', ['Em uso']));
    }
    if (!rows.length) rows.push(lrow('Nenhum modelo ainda', '', []));
    $('llamaModels').replaceChildren(...rows);

    $('llamaSuggestions').replaceChildren(
      ...localState.llama.suggestions
        .filter((m) => !installed.some((i) => i.name === m.file))
        .map((m) =>
          lrow(
            m.name,
            `${(m.mb / 1000).toFixed(1)} GB, ${m.note}`,
            progressParts(`llm:${m.file}`) || [button('Baixar', () => api.localLlmModel(m.url))]
          )
        )
    );
  }

  async function refreshLocal() {
    const state = await guard(() => api.localStatus());
    if (state) {
      localState = state;
      renderLocal();
    }
  }

  $('ggufDownload').addEventListener('click', () =>
    guard(async () => {
      const url = $('ggufUrl').value.trim();
      if (!url) return toast('Cole o endereço do arquivo .gguf.', true);
      $('ggufUrl').value = '';
      await api.localLlmModel(url);
    })
  );
  $('ggufPick').addEventListener('click', () =>
    guard(async () => {
      const file = await api.localPickGguf();
      if (file) await api.setSettings({ llamaModel: file });
    })
  );
  api.on('local', (state) => {
    localState = state;
    renderLocal();
  });

  /* ---------- ferramentas (MCP) ---------- */

  let mcpServers = [];
  let mcpStatus = [];
  let selectedServer = null;
  const STATE_LABEL = { off: 'Desativado', connecting: 'Conectando...', ready: 'Conectado', error: 'Com erro' };

  const statusOf = (id) => mcpStatus.find((s) => s.id === id) || { state: 'connecting', error: '', tools: [] };

  function renderServerStatus() {
    const server = mcpServers.find((s) => s.id === selectedServer);
    if (!server) return;
    const st = statusOf(server.id);
    $('mStatus').textContent =
      st.state === 'error' ? `Erro: ${st.error}` : `${STATE_LABEL[st.state]}. ${st.tools.length} ferramentas.`;
    $('mTools').replaceChildren(
      ...st.tools.map((t) => lrow(t.name, t.description.slice(0, 90), [t.readOnly ? 'só leitura' : 'pede confirmação']))
    );
  }

  function renderServers(fillForm) {
    if (!mcpServers.some((s) => s.id === selectedServer)) {
      selectedServer = mcpServers.length ? mcpServers[0].id : null;
      fillForm = true;
    }
    $('serverList').replaceChildren(
      ...mcpServers.map((s) => {
        const item = document.createElement('button');
        item.className = `item${s.id === selectedServer ? ' on' : ''}`;
        const name = document.createElement('strong');
        name.textContent = s.name;
        const note = document.createElement('span');
        note.textContent = STATE_LABEL[statusOf(s.id).state];
        item.append(name, note);
        item.addEventListener('click', () => {
          selectedServer = s.id;
          renderServers(true);
        });
        return item;
      })
    );
    const server = mcpServers.find((s) => s.id === selectedServer);
    $('mEmpty').hidden = Boolean(server);
    $('mDetail').hidden = !server;
    if (!server) return;
    if (fillForm) {
      $('mName').value = server.name;
      $('mType').value = server.type;
      $('mCommand').value = server.command || '';
      $('mArgs').value = server.args || '';
      $('mEnv').value = server.env || '';
      $('mUrl').value = server.url || '';
      $('mHeaders').value = server.headers || '';
      $('mEnabled').checked = Boolean(server.enabled);
      $('mTrust').checked = Boolean(server.trust);
      showServerType();
    }
    renderServerStatus();
  }

  function showServerType() {
    const http = $('mType').value === 'http';
    $('mStdio').hidden = http;
    $('mHttp').hidden = !http;
  }
  $('mType').addEventListener('change', showServerType);

  function applyMcp(state, fillForm) {
    mcpServers = state.servers;
    mcpStatus = state.status;
    renderServers(fillForm);
  }

  async function refreshMcp() {
    const state = await guard(() => api.mcpGet());
    if (state) applyMcp(state, true);
  }

  $('newServer').addEventListener('click', () =>
    guard(async () => {
      const id = `m${Date.now().toString(36)}`;
      selectedServer = id;
      const server = { id, name: 'Novo servidor', type: 'stdio', command: '', args: '', env: '', url: '', headers: '', enabled: false, trust: false };
      applyMcp(await api.mcpSave([...mcpServers, server]), true);
      $('mName').focus();
      $('mName').select();
    })
  );
  $('mSave').addEventListener('click', () =>
    guard(async () => {
      const next = mcpServers.map((s) =>
        s.id === selectedServer
          ? {
              ...s,
              name: $('mName').value.trim() || 'Sem nome',
              type: $('mType').value,
              command: $('mCommand').value.trim(),
              args: $('mArgs').value.trim(),
              env: $('mEnv').value,
              url: $('mUrl').value.trim(),
              headers: $('mHeaders').value,
              enabled: $('mEnabled').checked,
              trust: $('mTrust').checked,
            }
          : s
      );
      applyMcp(await api.mcpSave(next), true);
      toast('Servidor salvo.');
    })
  );
  $('mReconnect').addEventListener('click', () => guard(async () => applyMcp(await api.mcpReconnect(selectedServer), false)));
  $('mDelete').addEventListener('click', () =>
    guard(async () => {
      if (!confirm('Excluir este servidor?')) return;
      applyMcp(await api.mcpSave(mcpServers.filter((s) => s.id !== selectedServer)), true);
    })
  );
  api.on('mcp', (status) => {
    mcpStatus = status;
    renderServers(false);
  });

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
    renderLocal();
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
