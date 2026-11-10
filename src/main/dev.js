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

// ASIDE_CTX_TEST=<pasta>: gera um PDF e um DOCX de exemplo e confere a extracao de texto.
async function contextTest({ extractFile, dir }) {
  const { BrowserWindow } = require('electron');
  const path = require('path');
  const zlib = require('zlib');
  const log = (...args) => console.log('[contexto]', ...args);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const win = new BrowserWindow({ show: false });
    const html = '<h1>Currículo de teste</h1><p>Seis anos de experiência com Node e React.</p>';
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdfPath = path.join(dir, 'exemplo.pdf');
    fs.writeFileSync(pdfPath, await win.webContents.printToPDF({}));
    win.destroy();
    log('pdf:', JSON.stringify(await extractFile(pdfPath)));

    // DOCX minimo: um ZIP com word/document.xml comprimido.
    const name = Buffer.from('word/document.xml');
    const xml = Buffer.from('<w:document><w:body><w:p><w:r><w:t>Vaga: pessoa desenvolvedora plena</w:t></w:r></w:p><w:p><w:r><w:t>Requisito: SQL &amp; APIs</w:t></w:r></w:p></w:body></w:document>');
    const data = zlib.deflateRawSync(xml);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(xml.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(xml.length, 24);
    central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(46 + name.length, 12);
    end.writeUInt32LE(30 + name.length + data.length, 16);
    const docxPath = path.join(dir, 'exemplo.docx');
    fs.writeFileSync(docxPath, Buffer.concat([local, name, data, central, name, end]));
    log('docx:', JSON.stringify(await extractFile(docxPath)));

    const txtPath = path.join(dir, 'exemplo.txt');
    fs.writeFileSync(txtPath, 'Pauta: orçamento do trimestre.');
    log('txt:', JSON.stringify(await extractFile(txtPath)));
    log('binário:', JSON.stringify(await extractFile(process.execPath)));
  } catch (error) {
    log('FALHOU:', error.message);
  }
}

module.exports = { localTest, mcpTest, contextTest };
