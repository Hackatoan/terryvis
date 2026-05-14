/**
 * MatrixAsrClient — reuses the same whisper_server.py (terryvis-asr container).
 * Shares the ASR_URL with the Discord AsrClient; both bots can hit the same
 * Whisper instance simultaneously since requests are independent HTTP POSTs.
 */

const axios = require('axios');

const ASR_URL = process.env.WHISPER_URL || process.env.ASR_URL || 'http://terryvis-asr:5005/transcribe';
const STEREO_INT16_SAMPLES_PER_SEC = 48000 * 2;

function downsampleTo16kMono(pcm48kStereo) {
  const numSamples = Math.floor(pcm48kStereo.length / 2);
  const out16k     = new Int16Array(Math.floor(numSamples / 3));
  let outIdx       = 0;
  for (let i = 0; i < numSamples; i += 3) {
    if ((i + 2) * 2 + 1 >= pcm48kStereo.length) break;
    let sum = 0;
    for (let j = 0; j < 3; j++) {
      const idx = (i + j) * 2;
      sum += (pcm48kStereo[idx] + pcm48kStereo[idx + 1]) / 2;
    }
    out16k[outIdx++] = sum / 3;
  }
  return out16k;
}

function normalizeToTargetRms(int16Array, targetRms = 0.1, maxGain = 6.0) {
  if (!int16Array.length) return int16Array;
  let sumSq = 0;
  for (const s of int16Array) sumSq += (s / 32768) ** 2;
  const rms  = Math.sqrt(sumSq / int16Array.length);
  if (rms < 0.0001) return int16Array;
  const gain = Math.min(Math.max(targetRms / rms, 1.0), maxGain);
  const out  = new Int16Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++)
    out[i] = Math.max(-32768, Math.min(32767, int16Array[i] * gain));
  return out;
}

class MatrixAsrClient {
  constructor(webUI, roomManager) {
    this.webUI        = webUI;
    this.roomManager  = roomManager;
    // roomId:userId → { asrBuf: Int16[], transcribeQueue: Promise }
    this._streams = new Map();
  }

  /**
   * Called by LiveKitManager with PCM frames (Int16Array, 48kHz stereo).
   * Accumulates until silence, then fires transcription.
   */
  handleAudioFrame(roomId, userId, pcm16Stereo) {
    const key = `${roomId}:${userId}`;
    if (!this._streams.has(key)) {
      this._streams.set(key, {
        asrBuf:          [],
        transcribeQueue: Promise.resolve(),
        silenceTimer:    null,
      });
    }
    const st = this._streams.get(key);

    // Push samples
    for (let i = 0; i < pcm16Stereo.length; i++) st.asrBuf.push(pcm16Stereo[i]);

    // Reset silence timer — flush 500ms after the last frame arrives
    if (st.silenceTimer) clearTimeout(st.silenceTimer);
    st.silenceTimer = setTimeout(() => this._flush(roomId, userId, key), 500);
  }

  _flush(roomId, userId, key) {
    const st = this._streams.get(key);
    if (!st || st.asrBuf.length < STEREO_INT16_SAMPLES_PER_SEC * 0.2) return;

    const pcmRaw = Int16Array.from(st.asrBuf);
    st.asrBuf = [];

    let chunk16k = downsampleTo16kMono(pcmRaw);
    chunk16k     = normalizeToTargetRms(chunk16k, 0.1, 6.0);
    const audioBuf = Buffer.from(chunk16k.buffer);

    st.transcribeQueue = st.transcribeQueue.then(() =>
      axios.post(ASR_URL, audioBuf, {
        headers: { 'Content-Type': 'application/octet-stream', 'X-ASR-GRAMMAR': '["terry clip that"]' },
        timeout: 20000,
      }).then(res => {
        const text = String(res.data?.text || '').trim();
        if (!text) return;

        console.log(`[asr][${roomId}] ${userId}: "${text}"`);
        this.webUI.emitToAll('transcript', { roomId, userId, text, timestamp: Date.now() });

        const state = this.roomManager.getRoomState(roomId);
        const hist  = state.transcriptHistoryByUser.get(userId) || [];
        hist.push(text);
        if (hist.length > 5) hist.shift();
        state.transcriptHistoryByUser.set(userId, hist);

        if (this.roomManager.shouldTriggerClipFromContext(roomId, userId)) {
          console.log(`[asr] Voice trigger from ${userId} in ${roomId}`);
          // Signal main index to handle clip (needs Matrix client ref)
          this.webUI.emitToAll('voice_clip_trigger', { roomId, userId });
        }
      }).catch(() => {})
    );
  }
}

module.exports = MatrixAsrClient;
