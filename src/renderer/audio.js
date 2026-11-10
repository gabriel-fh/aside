// Captura de microfone e de audio do sistema, com corte por silencio.
// Cada trecho de fala vira um WAV mono de 16 kHz em base64.
(function () {
  const RATE = 16000;
  const SILENCE_MS = 700;
  const MAX_MS = 14000;
  const MIN_VOICED_MS = 300;
  const PREROLL_MS = 300;

  const WORKLET = `
    class PcmTap extends AudioWorkletProcessor {
      process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (channel) this.port.postMessage(channel.slice(0));
        return true;
      }
    }
    registerProcessor('pcm-tap', PcmTap);
  `;

  class Segmenter {
    constructor(speaker, onSegment) {
      this.speaker = speaker;
      this.onSegment = onSegment;
      this.floor = 0.004;
      this.level = 0;
      this.speaking = false;
      this.pre = [];
      this.preMs = 0;
      this.run = 0;
      this.isSuppressed = null;
      this.reset();
    }

    reset() {
      this.chunks = [];
      this.totalMs = 0;
      this.voicedMs = 0;
      this.silenceMs = 0;
      this.frames = 0;
      this.suppressed = 0;
      this.startTs = 0;
    }

    push(frame) {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);
      this.level = rms;
      const ms = (frame.length / RATE) * 1000;
      const voiced = rms > Math.max(0.012, this.floor * 3);

      if (!this.speaking) {
        if (!voiced) this.floor = this.floor * 0.98 + rms * 0.02;
        this.pre.push(frame);
        this.preMs += ms;
        while (this.preMs > PREROLL_MS) {
          this.preMs -= (this.pre.shift().length / RATE) * 1000;
        }
        this.run = voiced ? this.run + 1 : 0;
        if (this.run >= 3) {
          this.speaking = true;
          this.reset();
          this.chunks = this.pre;
          this.totalMs = this.preMs;
          this.startTs = Date.now() - this.preMs;
          this.pre = [];
          this.preMs = 0;
          this.run = 0;
        }
        return;
      }

      this.chunks.push(frame);
      this.totalMs += ms;
      this.frames++;
      if (this.isSuppressed && this.isSuppressed()) this.suppressed++;
      if (voiced) {
        this.voicedMs += ms;
        this.silenceMs = 0;
      } else {
        this.silenceMs += ms;
      }
      if (this.silenceMs >= SILENCE_MS || this.totalMs >= MAX_MS) this.flush();
    }

    flush() {
      const keep =
        this.speaking &&
        this.voicedMs >= MIN_VOICED_MS &&
        !(this.frames > 0 && this.suppressed / this.frames > 0.6);
      if (keep) this.onSegment({ speaker: this.speaker, wavBase64: encodeWav(this.chunks), ts: this.startTs });
      this.speaking = false;
      this.reset();
    }
  }

  function encodeWav(chunks) {
    let length = 0;
    for (const c of chunks) length += c.length;
    const buffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(buffer);
    const text = (offset, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };
    text(0, 'RIFF');
    view.setUint32(4, 36 + length * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, RATE, true);
    view.setUint32(28, RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, length * 2, true);
    let offset = 44;
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++, offset += 2) {
        const v = Math.max(-1, Math.min(1, c[i]));
        view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      }
    }
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  async function systemStream() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch {
      // Sem gesto do usuario (atalho global), o caminho antigo ainda entrega o loopback.
      const id = await window.aside.getDesktopSourceId();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id } },
      });
    }
    for (const track of stream.getVideoTracks()) {
      track.stop();
      stream.removeTrack(track);
    }
    if (!stream.getAudioTracks().length) throw new Error('O sistema não entregou áudio de saída.');
    return stream;
  }

  let state = null;

  async function start({ mic, system, speakerMode, onSegment, onLevel, onError }) {
    await stop();
    const ctx = new AudioContext({ sampleRate: RATE });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);

    state = { ctx, streams: [], segmenters: {}, timer: null };
    const attach = (stream, speaker) => {
      const segmenter = new Segmenter(speaker, onSegment);
      const node = new AudioWorkletNode(ctx, 'pcm-tap', { channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = (event) => segmenter.push(event.data);
      ctx.createMediaStreamSource(stream).connect(node);
      node.connect(mute);
      state.streams.push(stream);
      state.segmenters[speaker] = segmenter;
    };

    if (system) {
      try {
        attach(await systemStream(), 'them');
      } catch (error) {
        onError(`Áudio do sistema indisponível: ${error.message}`);
      }
    }
    if (mic) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        attach(stream, 'me');
      } catch (error) {
        onError(`Microfone indisponível: ${error.message}`);
      }
    }
    if (!state.streams.length) {
      await stop();
      throw new Error('Nenhuma fonte de áudio disponível.');
    }

    // Com alto-falantes, o microfone ouve o computador: descarta fala do microfone sobreposta ao sistema.
    const { me, them } = state.segmenters;
    if (speakerMode && me && them) me.isSuppressed = () => them.speaking;

    state.timer = setInterval(() => {
      onLevel({ me: me ? me.level : 0, them: them ? them.level : 0 });
    }, 100);
    return { mic: Boolean(me), system: Boolean(them) };
  }

  async function stop() {
    if (!state) return;
    const current = state;
    state = null;
    clearInterval(current.timer);
    for (const segmenter of Object.values(current.segmenters)) segmenter.flush();
    for (const stream of current.streams) for (const track of stream.getTracks()) track.stop();
    try {
      await current.ctx.close();
    } catch {
      // contexto ja fechado
    }
  }

  window.asideAudio = { start, stop };
})();
