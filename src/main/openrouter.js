// Cliente do OpenRouter: lista de modelos, transcricao por modelo com entrada de audio e chat em streaming.

const BASE = 'https://openrouter.ai/api/v1';

function headers(key) {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
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
  return new Error(`OpenRouter respondeu ${res.status}: ${String(detail).slice(0, 300)}`);
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
  if (json.error) throw new Error(json.error.message || 'Erro do OpenRouter');
  const raw = String((json.choices && json.choices[0] && json.choices[0].message.content) || '').trim();
  const [text, translation = ''] = raw.split(/\n\s*---\s*\n/);
  return { text: cleanTranscript(text), translation: translation.trim() };
}

// Remove respostas que nao sao fala: vazio, so pontuacao, ou marcacoes como (silencio) e [musica].
function cleanTranscript(text) {
  const t = String(text || '').trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return '';
  if (/^[\[(][^\])]*[\])]\.?$/.test(t)) return '';
  return t;
}

// Chat em streaming. Chama onDelta a cada pedaco e devolve o texto completo.
async function streamChat({ key, model, messages, signal, onDelta }) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(key),
    signal,
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!res.ok) throw await readError(res);

  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
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
      if (json.error) throw new Error(json.error.message || 'Erro do OpenRouter');
      const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
      if (delta) {
        full += delta;
        if (onDelta) onDelta(delta);
      }
    }
  }
  return full;
}

async function complete({ key, model, messages, signal }) {
  return streamChat({ key, model, messages, signal });
}

module.exports = { listModels, transcribe, streamChat, complete, cleanTranscript };
