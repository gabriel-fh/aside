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
async function streamTurn({ base = BASE, key, model, messages, tools, signal, onDelta }) {
  const body = { model, messages, stream: true };
  if (tools && tools.length) body.tools = tools;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: headers(key),
    signal,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);

  const decoder = new TextDecoder();
  const calls = [];
  let buffer = '';
  let text = '';
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
      const delta = json.choices && json.choices[0] && json.choices[0].delta;
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
  return { text, toolCalls };
}

// Chat completo: repete rodadas enquanto o modelo pedir ferramentas. Devolve todo o texto gerado.
async function runChat({ base, key, model, messages, tools, signal, onDelta, callTool, onTool, maxRounds = 6 }) {
  const history = messages.slice();
  let full = '';
  for (let round = 0; round < maxRounds; round++) {
    const useTools = round < maxRounds - 1 ? tools : undefined;
    const turn = await streamTurn({ base, key, model, messages: history, tools: useTools, signal, onDelta });
    full += turn.text;
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
  return full;
}

async function streamChat(options) {
  return (await streamTurn(options)).text;
}

async function complete({ base, key, model, messages, signal }) {
  return streamChat({ base, key, model, messages, signal });
}

module.exports = { listModels, transcribe, streamTurn, runChat, streamChat, complete, cleanTranscript };
