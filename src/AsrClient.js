const { EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const axios = require('axios');

const ASR_URL = process.env.WHISPER_URL || process.env.ASR_URL || 'http://localhost:5005/transcribe';
const TRANSCRIBE_FLUSH_MS = 2000;
const STEREO_INT16_SAMPLES_PER_SEC = 48000 * 2;
const TRIGGER_MIN_ENERGY = Number(process.env.TRIGGER_MIN_ENERGY || process.env.TRIGGER_GATE || 0.02);

function downsampleTo16kMono(pcm48kStereo) {
  const numSamples = Math.floor(pcm48kStereo.length / 2);
  const out16k = new Int16Array(Math.floor(numSamples / 3));
  let outIdx = 0;
  for (let i = 0; i < numSamples; i += 3) {
    if (i * 2 + 1 >= pcm48kStereo.length) break;
    const l = pcm48kStereo[i * 2];
    const r = pcm48kStereo[i * 2 + 1];
    out16k[outIdx++] = (l + r) / 2;
  }
  return out16k;
}

function normalizeToTargetRms(int16Array, targetRms = 0.1, maxGain = 6.0) {
  if (int16Array.length === 0) return int16Array;
  let sumSq = 0;
  for (let i = 0; i < int16Array.length; i++) {
    const norm = int16Array[i] / 32768.0;
    sumSq += norm * norm;
  }
  const rms = Math.sqrt(sumSq / int16Array.length);
  if (rms < 0.0001) return int16Array;
  let gain = targetRms / rms;
  if (gain > maxGain) gain = maxGain;
  if (gain < 1.0) gain = 1.0;
  if (Math.abs(gain - 1.0) < 0.01) return int16Array;

  const result = new Int16Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    result[i] = Math.max(-32768, Math.min(32767, Math.floor(int16Array[i] * gain)));
  }
  return result;
}

function toNodeBuffer(data) {
  try {
    if (!data) return null;
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
    if (data && Array.isArray(data.data)) return Buffer.from(data.data);
    if (typeof data.length === 'number') return Buffer.from(data);
  } catch (_) {}
  return null;
}

class AsrClient {
  constructor(webUI, guildManager) {
    this.webUI = webUI;
    this.guildManager = guildManager;
  }

  handleAudioStream(guildId, userId, receiver) {
    const state = this.guildManager.getGuildState(guildId);
    if (!state.activeStreams.has(userId)) {
      const userObj = this.guildManager.client.users.cache.get(userId);
      if (userObj && userObj.bot) return;

      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      const stream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 500 } });

      const st = {
        name: userObj ? userObj.username : userId,
        asrBuf: [],
        lastSend: Date.now(),
        transcribeQueue: Promise.resolve()
      };
      state.activeStreams.set(userId, st);

      stream.pipe(decoder);

      decoder.on('data', chunk => {
        const buf = toNodeBuffer(chunk);
        if (!buf) return;
        const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
        this.guildManager.writeToUserRing(guildId, userId, pcm);

        const activeSt = state.activeStreams.get(userId);
        if (activeSt) {
          for (let i = 0; i < pcm.length; i++) activeSt.asrBuf.push(pcm[i]);
        }
      });


      decoder.on('end', () => {
        const finalSt = state.activeStreams.get(userId);
        state.activeStreams.delete(userId);

        if (!finalSt || finalSt.asrBuf.length < (STEREO_INT16_SAMPLES_PER_SEC * 0.2)) {
           return;
        }

        const st = finalSt;

        try {
            let chunk16k = downsampleTo16kMono(Int16Array.from(st.asrBuf));
            chunk16k = normalizeToTargetRms(chunk16k, 0.1, 6.0);
            const audioBuffer = Buffer.from(chunk16k.buffer);
            const userName = st.name;
            const triggerGrammar = '["terry clip that"]'; // For Vosk

            st.transcribeQueue = st.transcribeQueue.then(() =>
              axios.post(ASR_URL, audioBuffer, {
                headers: { 'Content-Type': 'application/octet-stream', 'X-ASR-GRAMMAR': triggerGrammar },
                timeout: 20000
              }).then(res => {
                if (res.data && res.data.text) {
                  const transcriptText = String(res.data.text || '').trim();
                  if (!transcriptText) return;

                  this.webUI.emitToAll('transcript', { guildId, userId, username: userName, text: transcriptText, timestamp: Date.now() });

                  const hist = state.transcriptHistoryByUser.get(userId) || [];
                  hist.push(transcriptText);
                  if (hist.length > 5) hist.shift();
                  state.transcriptHistoryByUser.set(userId, hist);

                  if (this.guildManager.shouldTriggerClipFromContext(guildId, userId)) {
                      this.guildManager.handleVoiceClipCommand(guildId, userName, userId, null, null, state.currentChannelId);
                  }
                }
              }).catch(() => {})
            );
        } catch (_) {}
      });

      decoder.on('error', () => { state.activeStreams.delete(userId); });
    }
  }
}

module.exports = AsrClient;
