// Cliente MCP: conecta aos servidores configurados, expoe as ferramentas ao modelo e executa as chamadas.

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const CONNECT_TIMEOUT_MS = 30000;
const CALL_TIMEOUT_MS = 60000;
const RESULT_LIMIT = 12000;

let servers = [];
let onChange = () => {};
let confirm = async () => false;
const conns = new Map();
let toolIndex = new Map();

function init(options) {
  onChange = options.onChange;
  confirm = options.confirm;
}

// "CHAVE=valor" ou "Nome: valor", uma por linha.
function parseLines(text, separator) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const at = line.indexOf(separator);
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (key) out[key] = line.slice(at + 1).trim();
  }
  return out;
}

function splitArgs(text) {
  const out = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(text || '')))) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function buildTransport(server) {
  if (server.type === 'http') {
    let url;
    try {
      url = new URL(server.url);
    } catch {
      throw new Error('Endereço do servidor inválido.');
    }
    return new StreamableHTTPClientTransport(url, { requestInit: { headers: parseLines(server.headers, ':') } });
  }
  if (!String(server.command || '').trim()) throw new Error('Informe o comando do servidor.');
  return new StdioClientTransport({
    command: server.command.trim(),
    args: splitArgs(server.args),
    env: { ...process.env, ...parseLines(server.env, '=') },
    stderr: 'ignore',
  });
}

async function connect(server) {
  const conn = { sig: JSON.stringify(server), client: null, tools: [], state: 'connecting', error: '' };
  conns.set(server.id, conn);
  emit();
  let client = null;
  try {
    client = new Client({ name: 'aside', version: '0.1.0' });
    await withTimeout(client.connect(buildTransport(server)), CONNECT_TIMEOUT_MS, 'O servidor não respondeu a tempo.');
    const { tools } = await client.listTools();
    if (conns.get(server.id) !== conn) {
      client.close().catch(() => {});
      return;
    }
    conn.client = client;
    conn.tools = tools || [];
    conn.state = 'ready';
    client.onclose = () => {
      if (conns.get(server.id) !== conn) return;
      conn.state = 'error';
      conn.error = 'Conexão encerrada.';
      conn.tools = [];
      conn.client = null;
      emit();
    };
  } catch (error) {
    if (client) client.close().catch(() => {});
    conn.state = 'error';
    conn.error = String(error.message || error).slice(0, 300);
  }
  emit();
}

function disconnect(id) {
  const conn = conns.get(id);
  if (!conn) return;
  conns.delete(id);
  if (conn.client) conn.client.close().catch(() => {});
}

// Ajusta as conexoes a lista configurada: liga as ativas, derruba as removidas ou alteradas.
function sync(list) {
  servers = Array.isArray(list) ? list : [];
  for (const [id, conn] of conns) {
    const server = servers.find((s) => s.id === id);
    if (!server || !server.enabled || conn.sig !== JSON.stringify(server)) disconnect(id);
  }
  for (const server of servers) {
    if (server.enabled && !conns.has(server.id)) connect(server);
  }
  emit();
}

function reconnect(id) {
  disconnect(id);
  const server = servers.find((s) => s.id === id);
  if (server && server.enabled) return connect(server);
  emit();
  return undefined;
}

function emit() {
  onChange(status());
}

function status() {
  return servers.map((server) => {
    const conn = conns.get(server.id);
    return {
      id: server.id,
      state: !server.enabled ? 'off' : conn ? conn.state : 'connecting',
      error: conn ? conn.error : '',
      tools: conn
        ? conn.tools.map((t) => ({
            name: t.name,
            description: t.description || '',
            readOnly: Boolean(t.annotations && t.annotations.readOnlyHint),
          }))
        : [],
    };
  });
}

// Ferramentas no formato de funcao da API de chat. O nome leva o indice do servidor para nao colidir.
function toolsForModel() {
  toolIndex = new Map();
  const out = [];
  servers.forEach((server, index) => {
    const conn = conns.get(server.id);
    if (!server.enabled || !conn || conn.state !== 'ready') return;
    for (const tool of conn.tools) {
      const name = `s${index}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      toolIndex.set(name, { server, conn, tool });
      out.push({
        type: 'function',
        function: {
          name,
          description: `[${server.name}] ${tool.description || tool.name}`.slice(0, 1000),
          parameters: tool.inputSchema || { type: 'object', properties: {} },
        },
      });
    }
  });
  return out;
}

function resultText(result) {
  const parts = [];
  for (const item of result.content || []) {
    if (item.type === 'text') parts.push(item.text);
    else if (item.type === 'resource' && item.resource && item.resource.text) parts.push(item.resource.text);
    else parts.push(`[conteúdo do tipo ${item.type} omitido]`);
  }
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join('\n').slice(0, RESULT_LIMIT) || '(sem conteúdo)';
  return result.isError ? `Erro da ferramenta: ${text}` : text;
}

// Executa uma chamada pedida pelo modelo. Devolve sempre texto, inclusive em caso de erro ou recusa.
async function call(name, argsJson) {
  const entry = toolIndex.get(name);
  if (!entry) return `Ferramenta desconhecida: ${name}`;
  let args = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return 'Os argumentos não são um JSON válido.';
  }
  const { server, conn, tool } = entry;
  const readOnly = Boolean(tool.annotations && tool.annotations.readOnlyHint);
  if (!server.trust && !readOnly) {
    const allowed = await confirm({ server: server.name, tool: tool.name, args });
    if (!allowed) return 'O usuário negou a execução desta ferramenta.';
  }
  if (!conn.client) return 'O servidor desta ferramenta está desconectado.';
  try {
    const result = await withTimeout(
      conn.client.callTool({ name: tool.name, arguments: args }),
      CALL_TIMEOUT_MS,
      'A ferramenta não respondeu a tempo.'
    );
    return resultText(result);
  } catch (error) {
    return `Erro ao executar a ferramenta: ${error.message}`;
  }
}

function label(name) {
  const entry = toolIndex.get(name);
  return entry ? `${entry.server.name}: ${entry.tool.name}` : name;
}

function closeAll() {
  for (const id of [...conns.keys()]) disconnect(id);
}

module.exports = { init, sync, reconnect, status, toolsForModel, call, label, closeAll };
