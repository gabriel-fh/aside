// Cliente de chat: lista de modelos do OpenRouter, transcricao por modelo com entrada de audio
// e chat em streaming com chamadas de ferramenta. Serve para qualquer servidor compativel com a API da OpenAI.

const BASE = 'https://openrouter.ai/api/v1';

function headers(key) {
  const out = { 'Content-Type': 'application/json' };
  if (key) out.Authorization = `Bearer ${key}`;
  return out;
}

async function readError(res) {
  let detail = '';
  try {
    const body = await res.text();
    try {
      const json = JSON.parse(body);
      detail = (json.error && json.error.message) || body;
    } catch {
      detail = body;
    }
  } catch {
    detail = '';
  }
  return new Error(`O provedor respondeu ${res.status}: ${String(detail).slice(0, 300)}`);
}

// Quem acompanha cota e consumo registra um observador. Ele recebe { base, model, limits, tokens }.
let observer = null;
function observe(fn) {
  observer = fn;
}
function report(info) {
  if (!observer) return;
  try {
    observer(info);
  } catch {
    // o medidor nunca pode derrubar uma resposta
  }
}

// Cabecalhos de limite que o servico devolve. No Groq, pedidos sao por dia e tokens sao por minuto.
function readLimits(res) {
  const num = (name) => {
    const value = res.headers.get(name);
    return value === null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  };
  const out = {
    reqLimit: num('x-ratelimit-limit-requests'),
    reqLeft: num('x-ratelimit-remaining-requests'),
    minuteLimit: num('x-ratelimit-limit-tokens'),
    minuteLeft: num('x-ratelimit-remaining-tokens'),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

// Conta aproximada para servicos que nao informam o consumo no fim da resposta.
function roughTokens(messages, text) {
  let chars = String(text || '').length;
  for (const m of messages || []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) if (part.type === 'text') chars += String(part.text || '').length;
    }
  }
  return Math.ceil(chars / 3.5);
}

let modelsCache = null;

async function listModels(force = false) {
  if (modelsCache && !force) return modelsCache;
  const res = await fetch(`${BASE}/models`);
  if (!res.ok) throw await readError(res);
  const json = await res.json();
  modelsCache = (json.data || [])
    .filter((m) => m.pricing && Number(m.pricing.prompt) >= 0)
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      input: (m.architecture && m.architecture.input_modalities) || ['text'],
      promptPrice: Number(m.pricing.prompt) * 1e6,
      completionPrice: Number(m.pricing.completion) * 1e6,
    }));
  return modelsCache;
}

// Envia um trecho de audio (WAV em base64) e devolve { text, translation }.
async function transcribe({ key, model, wavBase64, language, translateTo, signal }) {
  const rules = [
    'Transcreva a fala deste áudio exatamente como foi dita, com pontuação.',
    language ? `Idioma esperado: ${language}.` : '',
    'Responda só com a transcrição, sem comentários, sem aspas e sem descrever sons.',
    'Se não houver fala inteligível, responda com uma linha vazia.',
    translateTo
      ? `Depois da transcrição, escreva uma linha contendo apenas --- e, na linha seguinte, a tradução para ${translateTo}.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(key),
    signal,
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: rules },
            { type: 'input_audio', input_audio: { data: wavBase64, format: 'wav' } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw await readError(res);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Erro do provedor');
  const raw = String((json.choices && json.choices[0] && json.choices[0].message.content) || '').trim();
  const [text, translation = ''] = raw.split(/\n\s*---\s*\n/);
  return { text: cleanTranscript(text), translation: translation.trim() };
}

// Remove respostas que nao sao fala: vazio, so pontuacao, ou marcacoes como (silencio) e [musica].
function cleanTranscript(text) {
  const t = String(text || '').trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return '';
  if (/^[\[(][^\])]*[\])]\.?$/.test(t)) return '';
  // Frases que o Whisper inventa em trechos sem fala.
  if (/amara\.org|legendas pela comunidade/i.test(t)) return '';
  return t;
}

// Uma rodada de chat em streaming. Devolve o texto e as chamadas de ferramenta pedidas pelo modelo.
async function streamTurn({ base = BASE, key, model, messages, tools, signal, onDelta, maxTokens }) {
  const body = { model, messages, stream: true };
  // Teto de saida: provedores com limite por minuto contam esse teto no pedido.
  if (maxTokens) body.max_tokens = maxTokens;
  if (tools && tools.length) body.tools = tools;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: headers(key),
    signal,
    body: JSON.stringify(body),
  });
  const limits = readLimits(res);
  if (!res.ok) {
    report({ base, model, limits, tokens: 0 });
    throw await readError(res);
  }

  const decoder = new TextDecoder();
  const calls = [];
  let buffer = '';
  let text = '';
  let finishReason = '';
  let usage = null;
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) throw new Error(json.error.message || 'Erro do provedor');
      // Consumo real: o Groq manda em x_groq.usage, outros servicos em usage.
      if (json.usage) usage = json.usage;
      if (json.x_groq && json.x_groq.usage) usage = json.x_groq.usage;
      const choice = json.choices && json.choices[0];
      if (choice && choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice && choice.delta;
      if (!delta) continue;
      if (delta.content) {
        text += delta.content;
        if (onDelta) onDelta(delta.content);
      }
      for (const part of delta.tool_calls || []) {
        const index = part.index || 0;
        if (!calls[index]) calls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        const call = calls[index];
        if (part.id) call.id = part.id;
        if (part.function && part.function.name) call.function.name += part.function.name;
        if (part.function && part.function.arguments) call.function.arguments += part.function.arguments;
      }
    }
  }
  const toolCalls = calls.filter(Boolean).map((call, i) => ({ ...call, id: call.id || `call_${i}` }));
  const counted = usage && Number(usage.total_tokens);
  report({ base, model, limits, tokens: counted > 0 ? counted : roughTokens(messages, text) });
  return { text, toolCalls, finishReason };
}

// Chat completo: repete rodadas enquanto o modelo pedir ferramentas.
// Devolve { text, truncated }: `truncated` indica que a resposta bateu no teto de saida.
async function runChat({ base, key, model, messages, tools, signal, onDelta, callTool, onTool, maxTokens, maxRounds = 6 }) {
  const history = messages.slice();
  let full = '';
  let truncated = false;
  for (let round = 0; round < maxRounds; round++) {
    const useTools = round < maxRounds - 1 ? tools : undefined;
    const turn = await streamTurn({ base, key, model, messages: history, tools: useTools, signal, onDelta, maxTokens });
    full += turn.text;
    truncated = turn.finishReason === 'length';
    if (!turn.toolCalls.length || !callTool) break;
    history.push({ role: 'assistant', content: turn.text || null, tool_calls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      if (onTool) onTool(call.function.name);
      const result = await callTool(call.function.name, call.function.arguments);
      if (signal && signal.aborted) throw new Error('Cancelado.');
      history.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }
    if (turn.text) {
      full += '\n\n';
      if (onDelta) onDelta('\n\n');
    }
  }
  return { text: full, truncated };
}

async function streamChat(options) {
  return (await streamTurn(options)).text;
}

async function complete({ base, key, model, messages, signal, maxTokens }) {
  return streamChat({ base, key, model, messages, signal, maxTokens });
}

// Prazo, em segundos, que um erro 429 manda esperar ("try again in 1h2m3.5s", "in 960ms"). Sem prazo, null.
function retryAfter(error) {
  const message = String((error && error.message) || '');
  if (!/\b429\b/.test(message)) return null;
  const match = message.match(/try again in ((?:[\d.]+\s*(?:ms|h|m|s)\s*)+)/i);
  if (!match) return null;
  const UNIT = { ms: 0.001, h: 3600, m: 60, s: 1 };
  let seconds = 0;
  for (const [, amount, unit] of match[1].matchAll(/([\d.]+)\s*(ms|h|m|s)/gi)) {
    seconds += Number(amount) * UNIT[unit.toLowerCase()];
  }
  return Number.isFinite(seconds) ? seconds : null;
}

// Se o erro for limite por minuto (429) com prazo curto, devolve quantos segundos esperar. Senao, null.
function rateLimitWait(error) {
  const seconds = retryAfter(error);
  return seconds !== null && seconds <= 45 ? seconds : null;
}

module.exports = {
  observe,
  retryAfter,
  listModels,
  transcribe,
  streamTurn,
  runChat,
  streamChat,
  complete,
  cleanTranscript,
  rateLimitWait,
};
