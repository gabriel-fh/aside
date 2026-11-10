// Verificacoes de desenvolvimento, acionadas por variavel de ambiente. Nao rodam no uso normal.

const fs = require('fs');

// ASIDE_LOCAL_TEST=<arquivo.wav>: instala o que faltar, transcreve o arquivo e faz uma pergunta ao modelo local.
async function localTest({ local, settings, openrouter, wavPath }) {
  const before = settings.load();
  const restore = { whisperModel: before.whisperModel, whisperLang: before.whisperLang };
  const log = (...args) => console.log('[local]', ...args);
  try {
    let state = local.status();
    if (!state.whisper.variants.find((v) => v.id === 'cpu').installed) {
      log('instalando whisper.cpp', await local.installBinary('whisper', 'cpu'));
    }
    if (!state.whisper.models.find((m) => m.id === 'tiny').installed) {
      log('baixando modelo tiny');
      await local.downloadWhisperModel('tiny');
    }
    settings.update({ whisperVariant: 'cpu', whisperModel: 'tiny', whisperLang: 'en' });
    let started = Date.now();
    const text = await local.transcribe({ wavBase64: fs.readFileSync(wavPath).toString('base64'), language: 'en' });
    log(`transcrição em ${Date.now() - started} ms:`, text);

    state = local.status();
    const variant = settings.load().llamaVariant;
    if (!state.llama.variants.find((v) => v.id === variant).installed) {
      log('instalando llama.cpp', await local.installBinary('llama', variant));
    }
    if (!settings.load().llamaModel) {
      const smallest = state.llama.suggestions[0];
      const existing = state.llama.models.find((m) => m.name === smallest.file);
      log('modelo de teste:', smallest.name);
      settings.update({ llamaModel: existing ? existing.path : await local.downloadLlmModel(smallest.url) });
    }
    started = Date.now();
    const answer = await openrouter.complete({
      base: await local.llamaBase(),
      model: 'local',
      messages: [{ role: 'user', content: 'Responda em uma frase curta: qual é a capital do Brasil?' }],
    });
    log(`resposta em ${Date.now() - started} ms:`, answer.trim());
  } catch (error) {
    log('FALHOU:', error.message);
  } finally {
    settings.update(restore);
    local.stopAll();
  }
}

// ASIDE_MCP_TEST=1: conecta ao servidor de teste e roda o laco de ferramentas contra um provedor falso.
async function mcpTest({ mcp, openrouter }) {
  const http = require('http');
  const path = require('path');
  const log = (...args) => console.log('[mcp]', ...args);
  let confirms = 0;

  // Provedor falso: na primeira rodada pede a ferramenta, na segunda responde com o resultado dela.
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { messages } = JSON.parse(body);
      const toolMessage = messages.find((m) => m.role === 'tool');
      const send = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (!toolMessage) {
        send({ tool_calls: [{ index: 0, id: 'c1', function: { name: 's0_somar', arguments: '{"a":2,' } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: '"b":40}' } }] });
      } else {
        send({ content: 'A soma é ' });
        send({ content: `${toolMessage.content}.` });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));

  try {
    mcp.init({
      onChange: () => {},
      confirm: async () => {
        confirms++;
        return true;
      },
    });
    const script = path.join(__dirname, '..', '..', 'dev', 'mcp-test-server.js');
    mcp.sync([{ id: 't', name: 'Teste', type: 'stdio', command: 'node', args: `"${script}"`, env: '', enabled: true, trust: false }]);
    for (let i = 0; i < 100 && mcp.status()[0].state === 'connecting'; i++) await new Promise((r) => setTimeout(r, 100));
    log('estado:', JSON.stringify(mcp.status()[0]));
    const tools = mcp.toolsForModel();
    log('ferramentas:', tools.map((t) => t.function.name).join(', '));
    const used = [];
    const answer = await openrouter.runChat({
      base: `http://127.0.0.1:${fake.address().port}`,
      model: 'falso',
      messages: [{ role: 'user', content: 'Quanto é 2 + 40?' }],
      tools,
      callTool: (name, args) => mcp.call(name, args),
      onTool: (name) => used.push(mcp.label(name)),
    });
    log('usou:', used.join(', '), '| resposta:', answer, '| confirmações:', confirms);
    log('com confirmação:', await mcp.call('s0_anotar', '{"texto":"oi"}'), '| confirmações:', confirms);
  } catch (error) {
    log('FALHOU:', error.message);
  } finally {
    mcp.closeAll();
    fake.close();
  }
}

module.exports = { localTest, mcpTest };
