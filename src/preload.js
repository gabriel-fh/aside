// Ponte entre a interface e o processo principal. So expoe chamadas nomeadas.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

const EVENTS = ['settings', 'session', 'transcript', 'answer:start', 'answer:delta', 'answer:end', 'status', 'cmd'];

contextBridge.exposeInMainWorld('aside', {
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  setApiKey: invoke('key:set'),
  listModels: invoke('models:list'),

  startSession: invoke('session:start'),
  stopSession: invoke('session:stop'),
  getSession: invoke('session:state'),
  sendSegment: invoke('audio:segment'),
  getDesktopSourceId: invoke('audio:desktop-source'),

  ask: invoke('ask'),
  cancelAsk: invoke('ask:cancel'),

  historyList: invoke('history:list'),
  historyGet: invoke('history:get'),
  historyDelete: invoke('history:delete'),
  historySummarize: invoke('history:summarize'),
  historyExport: invoke('history:export'),
  pickFolder: invoke('dialog:folder'),

  setIgnoreMouse: (ignore) => ipcRenderer.send('overlay:ignore', Boolean(ignore)),
  moveBy: (dx, dy) => ipcRenderer.send('overlay:move-by', dx, dy),
  hideOverlay: () => ipcRenderer.send('overlay:hide'),
  openSettings: (tab) => ipcRenderer.send('settings:open', tab),
  quit: () => ipcRenderer.send('app:quit'),

  on(event, handler) {
    if (!EVENTS.includes(event)) return () => {};
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
