// Assistentes padrao e montagem das mensagens enviadas ao modelo.

const DEFAULT_ASSISTANTS = [
  {
    id: 'reuniao',
    name: 'Reunião',
    prompt:
      'Contexto: o usuário está em uma reunião ou chamada. Ajude a acompanhar a conversa: responda perguntas feitas a ele, lembre pontos já ditos, aponte decisões, pendências e riscos. Quando sugerir algo para dizer, escreva em frases curtas e naturais.',
  },
  {
    id: 'estudo',
    name: 'Estudo e código',
    prompt:
      'Contexto: o usuário está estudando ou resolvendo um problema técnico. Explique passo a passo, mostre o raciocínio antes do resultado e use blocos de código com a linguagem identificada. Para problemas de algoritmo, informe a complexidade de tempo e de espaço e cite casos de borda.',
  },
  {
    id: 'geral',
    name: 'Geral',
    prompt: 'Contexto: uso geral. Responda de forma objetiva ao que foi pedido.',
  },
];

const BASE_PROMPT = [
  'Você é o Aside, um assistente que acompanha o usuário em tempo real em reuniões, aulas e sessões de estudo.',
  'Você recebe a transcrição recente (linhas [Eu] são do usuário, linhas [Eles] são de outras pessoas ou do áudio do computador), às vezes uma captura da tela, e um pedido.',
  'Responda de forma direta e curta, em markdown, começando pelo que importa.',
  'Não invente fatos que não estejam na conversa ou na tela. Se faltar informação, diga o que falta em uma frase.',
].join('\n');

const SPEAKER_LABEL = { me: 'Eu', them: 'Eles' };

function formatTranscript(lines, limit = 40) {
  return lines
    .slice(-limit)
    .map((l) => `[${SPEAKER_LABEL[l.speaker] || l.speaker}] ${l.text}`)
    .join('\n');
}

function buildChatMessages({ assistant, responseLanguage, lines, turns, request, imageDataUrl }) {
  const system = [
    BASE_PROMPT,
    assistant && assistant.prompt ? assistant.prompt : '',
    responseLanguage ? `Responda sempre neste idioma: ${responseLanguage}.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages = [{ role: 'system', content: system }];
  for (const t of turns.slice(-4)) {
    messages.push({ role: 'user', content: t.q });
    messages.push({ role: 'assistant', content: t.a });
  }

  const transcript = formatTranscript(lines);
  const text = [transcript ? `Transcrição recente:\n${transcript}` : '', `Pedido: ${request}`]
    .filter(Boolean)
    .join('\n\n');

  const content = [{ type: 'text', text }];
  if (imageDataUrl) content.push({ type: 'image_url', image_url: { url: imageDataUrl } });
  messages.push({ role: 'user', content });
  return messages;
}

function buildSummaryMessages({ lines, turns, responseLanguage }) {
  const qa = turns.map((t) => `Pergunta: ${t.q}\nResposta: ${t.a}`).join('\n\n');
  return [
    {
      role: 'system',
      content: [
        'Você resume sessões gravadas pelo Aside.',
        'Primeira linha: um título curto, sem markdown e sem aspas.',
        'Depois, em markdown: um resumo em poucos parágrafos, uma lista de decisões e uma lista de pendências com responsável quando houver.',
        'Use só o que está na transcrição.',
        responseLanguage ? `Escreva em: ${responseLanguage}.` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      role: 'user',
      content: [`Transcrição:\n${formatTranscript(lines, 2000)}`, qa ? `Perguntas ao assistente:\n${qa}` : '']
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
}

module.exports = { DEFAULT_ASSISTANTS, SPEAKER_LABEL, buildChatMessages, buildSummaryMessages };
