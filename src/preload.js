// Ponte entre a interface e o processo principal. So expoe chamadas nomeadas.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

const EVENTS = ['task', 'mcp', 'local', 'settings', 'session', 'transcript', 'answer:start', 'answer:meta', 'answer:delta', 'answer:end', 'status', 'cmd'];

contextBridge.exposeInMainWorld('aside', {
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  setApiKey: invoke('key:set'),
  listModels: invoke('models:list'),
  getKeys: invoke('keys:get'),
  setCustomKey: invoke('custom-key:set'),
  listCustomModels: invoke('custom:models'),

  startSession: invoke('session:start'),
  stopSession: invoke('session:stop'),
  getSession: invoke('session:state'),
  sendSegment: invoke('audio:segment'),
  getDesktopSourceId: invoke('audio:desktop-source'),

  ask: invoke('ask'),
  cancelAsk: invoke('ask:cancel'),
  askRegion: invoke('ask:region'),
  askCheck: invoke('ask:check'),
  getTask: invoke('task:get'),
  clearTask: invoke('task:clear'),
  regionDone: (rect) => ipcRenderer.send('region:done', rect),

  historyList: invoke('history:list'),
  historyGet: invoke('history:get'),
  historyDelete: invoke('history:delete'),
  historySummarize: invoke('history:summarize'),
  historyExport: invoke('history:export'),
  pickFolder: invoke('dialog:folder'),

  pickContextFiles: invoke('context:pick'),
  mcpGet: invoke('mcp:get'),
  mcpSave: invoke('mcp:save'),
  mcpReconnect: invoke('mcp:reconnect'),

  localStatus: invoke('local:status'),
  localInstall: invoke('local:install'),
  localWhisperModel: invoke('local:whisper-model'),
  localLlmModel: invoke('local:llm-model'),
  localDelete: invoke('local:delete'),
  localCancel: invoke('local:cancel'),
  localPickGguf: invoke('local:pick-gguf'),

  setIgnoreMouse: (ignore) => ipcRenderer.send('overlay:ignore', Boolean(ignore)),
  moveBy: (dx, dy) => ipcRenderer.send('overlay:move-by', dx, dy),
  hideOverlay: () => ipcRenderer.send('overlay:hide'),
  showOverlay: () => ipcRenderer.send('overlay:show'),
  toggleSession: () => ipcRenderer.send('home:toggle-session'),
  openKeysPage: () => ipcRenderer.send('open:keys'),
  openSettings: (tab) => ipcRenderer.send('settings:open', tab),
  quit: () => ipcRenderer.send('app:quit'),

  on(event, handler) {
    if (!EVENTS.includes(event)) return () => {};
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
