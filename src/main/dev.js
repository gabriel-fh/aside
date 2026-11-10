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

module.exports = { localTest };
