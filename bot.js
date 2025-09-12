

// --- Imports and Setup ---
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, EndBehaviorType, createAudioPlayer, createAudioResource, NoSubscriberBehavior, StreamType, AudioPlayerStatus, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const wav = require('wav');
const axios = require('axios');
const prism = require('prism-media');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// Express and Socket.io setup
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Optional env config
const WHISPER_URL = process.env.WHISPER_URL || 'http://localhost:5005/transcribe';

// Helper: coerce various binary forms into a Node Buffer
function toNodeBuffer(data) {
  try {
    if (!data) return null;
    if (Buffer.isBuffer(data)) return data;
    // Browser sent Uint8Array
    if (data instanceof Uint8Array) {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    // Raw ArrayBuffer
    if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) {
      return Buffer.from(new Uint8Array(data));
    }
    // Socket.IO may JSONify Buffer as { type: 'Buffer', data: number[] }
    if (data && Array.isArray(data.data)) {
      return Buffer.from(data.data);
    }
    // As a last resort, try constructing from typed array-like
    if (typeof data.length === 'number') {
      return Buffer.from(data);
    }
  } catch (_) { /* ignore */ }
  return null;
}

// Helper: play a file from disk into the current voice connection
async function playFileFromDisk(filePath, onStart, onEnd, onError) {
  try {
    if (!currentConnection) throw new Error('No voice connection');
    await entersState(currentConnection, VoiceConnectionStatus.Ready, 10000);
    if (!currentPlayer) {
      currentPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      try { currentConnection.subscribe(currentPlayer); } catch (_) {}
    }
    console.log('[playFile] spawning ffmpeg for PCM decode (raw s16le):', filePath);
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-re', '-i', filePath,
      '-vn', '-sn', '-dn',
      '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    ff.stderr.on('data', d => {
      const s = d.toString();
      if (s.trim()) console.warn('[playFile][ffmpeg]', s.trim());
    });
    ff.on('close', (code, signal) => {
      console.log('[playFile] ffmpeg exited code', code, 'signal', signal);
      if (typeof code === 'number' && code !== 0) {
        onError && onError(new Error('ffmpeg failed code ' + code));
      }
    });
    const pcm = ff.stdout;
    const enc = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
    enc.on('error', (e) => { console.warn('[playFile] opus encoder error:', e?.message || e); onError && onError(e); });
    const opus = pcm.pipe(enc);
    const resource = createAudioResource(opus, { inputType: StreamType.Opus });
    try { currentPlayer.stop(true); } catch (_) {}
    // Wire events
    const started = () => { onStart && onStart(); try { currentPlayer.off(AudioPlayerStatus.Playing, started); } catch (_) {} };
    const ended = () => { onEnd && onEnd(); try { currentPlayer.off(AudioPlayerStatus.Idle, ended); } catch (_) {} };
    try { currentPlayer.removeAllListeners(AudioPlayerStatus.Playing); } catch (_) {}
    try { currentPlayer.removeAllListeners(AudioPlayerStatus.Idle); } catch (_) {}
    currentPlayer.on(AudioPlayerStatus.Playing, started);
    currentPlayer.on(AudioPlayerStatus.Idle, ended);
    currentPlayer.on('error', (err) => { console.warn('[playFile] player error:', err?.message || err); onError && onError(err); });
    currentPlayer.play(resource);
  } catch (e) {
    onError && onError(e);
  }
}

// Discord client setup
const enabledIntents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];
const client = new Client({ intents: enabledIntents });
console.log('[init] Discord client starting with intents:', enabledIntents);
client.once('ready', () => {
  try {
    console.log(`[init] Logged in as ${client.user?.tag || client.user?.id || 'unknown'}`);
  } catch (_) {
    console.log('[init] Logged in (user unknown)');
  }
});

let monitorInterval;
// Buffers for web backfill/sync
const recentTranscripts = []; // { userId, username, text, timestamp }
const recentClips = []; // { url, username, timestamp }

// --- Persistent config for clip channel and DM preferences ---
const CONFIG_PATH = path.join(__dirname, 'clips-config.json');
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const data = JSON.parse(raw);
      return { guilds: data.guilds || {}, dmPrefs: data.dmPrefs || {} };
    }
  } catch (_) {}
  return { guilds: {}, dmPrefs: {} };
}
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (_) {}
}
let config = loadConfig();


// --- Real-time update of web UI when anyone joins/leaves the current channel ---
client.on('voiceStateUpdate', (oldState, newState) => {
  if (!currentChannelId) return;
  const guild = newState.guild;
  const channel = guild.channels.cache.get(currentChannelId);
  if (channel) updateWebMembers(channel);
});



// --- Audio/Clip Buffering and State ---
let currentChannelId = null;
let currentConnection = null; // active voice connection, if any
let currentPlayer = null; // audio player for playback
const CLIP_SECONDS = 30;
const CLIP_SAMPLE_RATE = 48000;
const CLIP_CHANNELS = 2;
// lastClipInfo no longer tracked
// Require users to be in a channel this long before we consider joining (ms)
const MIN_STABLE_MS = 3000;
// Per-user rolling ring buffers for 30s of 48kHz stereo Int16 PCM
const TOTAL_CLIP_SAMPLES = CLIP_SAMPLE_RATE * CLIP_CHANNELS * CLIP_SECONDS; // Int16 samples (not bytes)
// userId -> { buffer: Int16Array, writeIndex: number, filled: number, lastWriteTimeMs: number, lastEndMs: number, chunks: Array<{ endMs:number, data:Int16Array }>} 
const userRings = new Map();

function writeToUserRing(userId, pcm16Stereo) {
  let ring = userRings.get(userId);
  if (!ring) {
    ring = { buffer: new Int16Array(TOTAL_CLIP_SAMPLES), writeIndex: 0, filled: 0, lastWriteTimeMs: 0, lastEndMs: 0, chunks: [] };
    userRings.set(userId, ring);
  }
  const buf = ring.buffer;
  let idx = ring.writeIndex;
  for (let i = 0; i < pcm16Stereo.length; i++) {
    buf[idx] = pcm16Stereo[i];
    idx++;
    if (idx >= buf.length) idx = 0;
  }
  ring.writeIndex = idx;
  // Track how many valid samples we have in the ring (saturate at capacity)
  ring.filled = Math.min(TOTAL_CLIP_SAMPLES, (ring.filled || 0) + pcm16Stereo.length);
  const now = Date.now();
  ring.lastWriteTimeMs = now;
  // Timestamp this chunk using a running end-of-audio clock to insert real-time silence gaps.
  const durationMs = Math.round((pcm16Stereo.length / (CLIP_SAMPLE_RATE * CLIP_CHANNELS)) * 1000);
  const proposedEnd = ring.lastEndMs ? Math.max(ring.lastEndMs + durationMs, now) : now;
  ring.lastEndMs = proposedEnd;
  ring.chunks.push({ endMs: proposedEnd, data: pcm16Stereo });
  // Prune chunks older than window + small cushion
  const windowStart = now - (CLIP_SECONDS * 1000) - 1000; // 1s cushion
  while (ring.chunks.length && (ring.chunks[0].endMs - Math.floor(ring.chunks[0].data.length / (CLIP_CHANNELS * CLIP_SAMPLE_RATE) * 1000)) < windowStart) {
    ring.chunks.shift();
  }
}

// Build exact last-30s mix using per-chunk timestamps and per-user RMS balancing
function getLast30sMix(memberIds) {
  const out32 = new Int32Array(TOTAL_CLIP_SAMPLES);
  const sr = CLIP_SAMPLE_RATE * CLIP_CHANNELS; // samples/sec stereo
  const now = Date.now();
  const windowStart = now - (CLIP_SECONDS * 1000);

  // First pass: compute per-user RMS over samples within window
  const userGain = new Map();
  for (const userId of memberIds) {
    const ring = userRings.get(userId);
    if (!ring || !ring.chunks || ring.chunks.length === 0) continue;
    let sumSq = 0;
    let count = 0;
    for (const { endMs, data } of ring.chunks) {
  const chunkStartMs = endMs - Math.round((data.length / sr) * 1000);
      if (endMs <= windowStart || chunkStartMs >= now) continue;
      // Clip to window but RMS across actual samples still fine
      for (let i = 0; i < data.length; i++) {
        const v = data[i] / 32768;
        sumSq += v * v;
      }
      count += data.length;
    }
    const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
    // Target per-user RMS ≈ -16 dBFS => linear ≈ 10^(-16/20) ≈ 0.1585
    let g = 1.0;
    if (rms > 1e-6) {
      g = 0.1585 / rms;
      if (g < 0.2) g = 0.2;
      if (g > 8.0) g = 8.0;
    }
    userGain.set(userId, g);
  }

  // Second pass: place chunks into timeline and mix with user gain
  for (const userId of memberIds) {
    const ring = userRings.get(userId);
    if (!ring || !ring.chunks) continue;
    const g = userGain.get(userId) || 1.0;
    for (const { endMs, data } of ring.chunks) {
  const chunkStartMs = endMs - Math.round((data.length / sr) * 1000);
      if (endMs <= windowStart || chunkStartMs >= now) continue; // outside window
      // Compute destination indices
      let dstStart = Math.floor(((chunkStartMs - windowStart) / 1000) * sr);
      let srcStart = 0;
      let copyLen = data.length;
      // Trim if chunk starts before window
      if (dstStart < 0) {
        const drop = -dstStart;
        srcStart += drop;
        copyLen -= drop;
        dstStart = 0;
      }
      // Trim if chunk extends past window end
      if (dstStart + copyLen > TOTAL_CLIP_SAMPLES) {
        copyLen = TOTAL_CLIP_SAMPLES - dstStart;
      }
      if (copyLen <= 0) continue;
      // Mix with gain and tiny edge ramps to reduce boundary clicks (≈1ms)
      const fadeLen = Math.min(96, Math.floor(copyLen / 8)); // up to ~1ms at 48kHz stereo
      let di = dstStart;
      for (let k = 0; k < copyLen; k++, di++) {
        const si = srcStart + k;
        let mul = 1.0;
        if (fadeLen > 0) {
          if (k < fadeLen) mul = k / fadeLen;
          else if (k >= copyLen - fadeLen) mul = (copyLen - 1 - k) / fadeLen;
          if (mul < 0) mul = 0; // guard
        }
        const v = Math.round(data[si] * g * mul);
        out32[di] += v;
      }
    }
  }

  // Master peak normalization to avoid clipping-induced distortion
  let peak = 0;
  for (let i = 0; i < out32.length; i++) {
    const a = Math.abs(out32[i] | 0);
    if (a > peak) peak = a;
  }
  const targetPeak = 30000; // ~ -1.9 dBFS headroom
  const scale = peak > 32767 ? (targetPeak / peak) : 1.0;
  const out16 = new Int16Array(TOTAL_CLIP_SAMPLES);
  if (scale !== 1.0) {
    for (let i = 0; i < out32.length; i++) {
      let v = Math.round(out32[i] * scale);
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      out16[i] = v;
    }
  } else {
    for (let i = 0; i < out32.length; i++) {
      let v = out32[i];
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      out16[i] = v;
    }
  }
  return out16;
}

// Downsample 48kHz stereo Int16 to 16kHz mono Int16 (simple average + decimation by 3)
function downsampleTo16kMono(stereoInt16) {
  const outLen = Math.floor(stereoInt16.length / (CLIP_CHANNELS * 3));
  const out = new Int16Array(outLen);
  let o = 0;
  // Process in 6-sample chunks (3 stereo frames)
  for (let i = 0; i + 5 < stereoInt16.length; i += 6) {
    // Average 3 frames of L and R, then average channels to mono
    const l = (stereoInt16[i] + stereoInt16[i + 2] + stereoInt16[i + 4]) / 3;
    const r = (stereoInt16[i + 1] + stereoInt16[i + 3] + stereoInt16[i + 5]) / 3;
    let m = Math.round((l + r) / 2);
    if (m > 32767) m = 32767; else if (m < -32768) m = -32768;
    out[o++] = m;
  }
  return out.subarray(0, o);
}

// Normalize Int16 PCM roughly to a target RMS value (0-1 range), with clamp on extreme scale.
function normalizeToTargetRms(int16, target = 0.1, maxScale = 6.0) {
  if (!int16 || int16.length === 0) return int16;
  let sumSq = 0;
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i] / 32768;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / int16.length);
  if (!isFinite(rms) || rms <= 1e-6) return int16;
  let scale = target / rms;
  if (scale > maxScale) scale = maxScale;
  if (scale < 0.1) scale = 0.1;
  const out = new Int16Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    let v = Math.round(int16[i] * scale);
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    out[i] = v;
  }
  return out;
}
 



// Create and send a 30s clip of the current voice channel mix
function sanitizeClipTitle(raw) {
  let s = String(raw || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Allow letters, numbers, spaces, dashes, underscores, and parentheses
  s = s.replace(/[^a-zA-Z0-9 _\-()]/g, '');
  if (!s) s = 'clip';
  // Cap length
  if (s.length > 60) s = s.slice(0, 60).trim();
  return s;
}

async function handleVoiceClipCommand(requestedByName, requestedById, titleOptional) {
  try {
    const guild = client.guilds.cache.first();
    if (!guild || !currentChannelId) return;
    const voiceChan = guild.channels.cache.get(currentChannelId);
    if (!voiceChan) return;
    // Include all users who have spoken within the last 30s, even if they left the channel
  const now = Date.now();
  const cutoff = CLIP_SECONDS * 1000;
    const botId = client.user?.id;
    const gcfg = config.guilds[guild.id] || {};
    const includeBots = !!gcfg.clipBots;
    const windowStart = now - cutoff;
    const memberIds = Array.from(userRings.entries())
      .filter(([uid, ring]) => ring && ring.chunks && ring.chunks.some(ch => ch.endMs > windowStart))
      .filter(([uid]) => uid !== botId)
      .filter(([uid]) => includeBots || !(guild.members.cache.get(uid)?.user?.bot))
      .map(([uid]) => uid);
    if (memberIds.length === 0) return;
    const mixed = getLast30sMix(memberIds);
    // Ensure output directory exists
    const clipsDir = path.join(__dirname, 'public', 'clips');
    if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });
  // Unique filename to survive rapid successive clip requests
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const filePath = path.join(clipsDir, `clip_${unique}.wav`);
    const attachName = `${sanitizeClipTitle(titleOptional)}.wav`;

    // Write WAV using wav.Writer
    await new Promise((resolve, reject) => {
      const writer = new wav.Writer({ channels: CLIP_CHANNELS, sampleRate: CLIP_SAMPLE_RATE, bitDepth: 16 });
      const out = fs.createWriteStream(filePath);
      writer.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      writer.pipe(out);
  writer.write(Buffer.from(mixed.buffer));
      writer.end();
    });

    let delivered = false;
    // If the user has DM toggle enabled, try to send the clip to their DMs
    const dmOn = !!config.dmPrefs[requestedById];
    if (dmOn) {
      try {
        const user = await client.users.fetch(requestedById);
  const msg = await user.send({ content: `Here is your clip, ${requestedByName}`, files: [{ attachment: filePath, name: attachName }] });
        let att = null;
        try { att = msg.attachments && typeof msg.attachments.first === 'function' ? msg.attachments.first() : null; } catch (_) {}
        if (!att) {
          try {
            const it = msg.attachments?.values?.();
            const nxt = it && it.next ? it.next() : { done: true };
            if (nxt && !nxt.done) att = nxt.value;
          } catch (_) {}
        }
        if (att && att.url) deliveredUrl = att.url;
        delivered = true;
      } catch (_) { /* fall through to channel post if DM fails */ }
    }

  // If not delivered via DM, post to configured guild clip channel (fallback to env if unset)
    if (!delivered) {
      const guildCfg = config.guilds[guild.id] || {};
      const clipChannelId = guildCfg.clipChannelId || process.env.CLIPS_CHANNEL_ID;
      const clipsText = clipChannelId ? guild.channels.cache.get(clipChannelId) : null;
      if (clipsText && typeof clipsText.isTextBased === 'function' && clipsText.isTextBased()) {
        try {
          const msg = await clipsText.send({ content: `Clip requested by ${requestedByName}` , files: [{ attachment: filePath, name: attachName }] });
          let att = null;
          try { att = msg.attachments && typeof msg.attachments.first === 'function' ? msg.attachments.first() : null; } catch (_) {}
          if (!att) {
            try {
              const it = msg.attachments?.values?.();
              const nxt = it && it.next ? it.next() : { done: true };
              if (nxt && !nxt.done) att = nxt.value;
            } catch (_) {}
          }
          if (att && att.url) deliveredUrl = att.url;
          delivered = true;
        } catch (_) { /* ignore send errors */ }
      }
    }

    // Delete the local file after successful delivery
    if (delivered) {
      try { await fs.promises.unlink(filePath); } catch (_) {}
    }

    // If we have a URL for the posted clip, broadcast and remember it for the web UI
    if (deliveredUrl) {
      const clipInfo = { url: deliveredUrl, username: requestedByName, timestamp: Date.now(), title: sanitizeClipTitle(titleOptional) };
      recentClips.push(clipInfo);
      if (recentClips.length > 100) recentClips.shift();
      io.emit('clip_posted', clipInfo);
    }
  } catch (_) {
    // ignore errors; clipping is best-effort
  }
}

// Transcription pacing constants
// Make transcription segments longer for better accuracy
const TRANSCRIBE_CHUNK_MS = 1200; // ~1.2s chunks
const TRANSCRIBE_FLUSH_MS = 2500; // flush within ~2.5s
const STEREO_INT16_SAMPLES_PER_SEC = CLIP_SAMPLE_RATE * CLIP_CHANNELS; // 96,000 at 48kHz stereo
const MIN_CHUNK_SAMPLES_STEREO = Math.floor((STEREO_INT16_SAMPLES_PER_SEC * TRANSCRIBE_CHUNK_MS) / 1000);

let currentMembers = [];
// Track when each user joined a channel: { guildId: { userId: timestamp } }
const userJoinTimestamps = {};
// Track last emitted transcript per user to suppress duplicates
const lastTranscriptByUser = new Map();

// --- Intent detection: contextual, fuzzy "terry clip that" variants ---
// Keep a short rolling transcript context per user (last ~6s) to catch split utterances
const transcriptHistoryByUser = new Map(); // userId -> Array<{ text: string, t: number }>
const lastClipTriggerByUser = new Map(); // userId -> timestamp ms

function appendTranscriptContext(userId, text) {
  const now = Date.now();
  const arr = transcriptHistoryByUser.get(userId) || [];
  arr.push({ text: String(text || ''), t: now });
  // Keep only ~6 seconds of context
  const cutoff = now - 6000;
  while (arr.length && arr[0].t < cutoff) arr.shift();
  transcriptHistoryByUser.set(userId, arr);
  // Track recent transcripts for UI backfill
  const name = (currentMembers.find(m => m.id === userId)?.username) || '';
  recentTranscripts.push({ userId, username: name, text: String(text || ''), timestamp: now });
  // Keep at most 200 and prune anything older than ~30 minutes as a safety
  const staleCutoff = now - (30 * 60 * 1000);
  while (recentTranscripts.length > 200 || (recentTranscripts[0] && recentTranscripts[0].timestamp < staleCutoff)) {
    recentTranscripts.shift();
  }
}

function getContextText(userId) {
  const arr = transcriptHistoryByUser.get(userId) || [];
  return arr.map(x => String(x.text || '').toLowerCase()).join(' ');
}

function shouldTriggerClipFromContext(userId) {
  const now = Date.now();
  const last = lastClipTriggerByUser.get(userId) || 0;
  // Cooldown to avoid duplicate triggers
  if (now - last < 4000) return false;
  const ctx = getContextText(userId);
  if (!ctx) return false;
  // Common ASR confusions: clip/click
  const clipWord = '(?:clip|click)';
  // Pattern A: "terry" within ~5 words of clip
  const patA = new RegExp(`\\bterry\\b[\\s,]*(?:\\w+\\s+){0,5}?${clipWord}\\b(?:\\s+(?:it|that|this))?`);
  // Pattern B: clip that ... terry
  const patB = new RegExp(`${clipWord}\\b(?:\\s+(?:it|that|this))?(?:\\s+\\w+){0,5}\\s+terry\\b`);
  // Pattern C: polite/openers then terry then clip
  const openers = '(?:ok(?:ay)?|al+right|all right|hey|yo)';
  const patC = new RegExp(`\\b${openers}\\b[\\s,]*terry[\\s,]*(?:\\w+\\s+){0,4}?${clipWord}\\b(?:\\s+(?:it|that|this))?`);
  // Pattern D: short forms like "terry clip" or "terry, clip"
  const patD = new RegExp(`\\bterry[\\s,]*${clipWord}\\b`);

  const matched = patA.test(ctx) || patB.test(ctx) || patC.test(ctx) || patD.test(ctx);
  if (matched) {
    lastClipTriggerByUser.set(userId, now);
    // Clear context to reduce immediate retrigger from same words
    transcriptHistoryByUser.set(userId, []);
    return true;
  }

  // --- Fuzzy fallback: allow near-misses like "club that" near "terry" ---
  // Levenshtein distance for small words
  function lev(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }
    return dp[m][n];
  }

  function normalizeTok(tok) {
    return (tok || '').toLowerCase().replace(/[^a-z]/g, '');
  }

  const nearClipWhitelist = new Set(['clip', 'click', 'clips', 'clipped', 'cliff', 'club']);
  function looksLikeClipCore(t) {
    if (!t) return false;
    if (nearClipWhitelist.has(t)) return true;
    // Distance threshold of 1 for very short word
    return lev(t, 'clip') <= 1;
  }
  function looksLikeClip(tok) {
    const t = normalizeTok(tok);
    if (!t) return false;
    if (looksLikeClipCore(t)) return true;
    // Handle re- prefixed single token like "reclip"
    if (t.startsWith('re') && looksLikeClipCore(t.slice(2))) return true;
    return false;
  }

  const words = ctx.split(/\s+/).map(w => w.trim()).filter(Boolean);
  const lower = words.map(w => normalizeTok(w));
  const terryIdx = lower.map((w, i) => ({ w, i })).filter(x => x.w === 'terry').map(x => x.i);

  // Case 1: after "terry", within 5 tokens, a near-clip word (supports "re clip" and "reclip")
  for (const ti of terryIdx) {
    for (let j = ti + 1; j <= Math.min(lower.length - 1, ti + 5); j++) {
      const tok = lower[j];
      const nextTok = lower[j + 1] || '';
      if (looksLikeClip(tok) || (tok === 're' && looksLikeClipCore(nextTok))) {
        lastClipTriggerByUser.set(userId, now);
        transcriptHistoryByUser.set(userId, []);
        return true;
      }
    }
  }

  // Case 2: pattern like "(clip~) (that|it|this) ... terry" within a short window
  const pronouns = new Set(['that', 'it', 'this']);
  for (let i = 0; i < lower.length; i++) {
    const tok = lower[i];
    const isClipish = looksLikeClip(tok) || (tok === 're' && looksLikeClipCore(lower[i + 1] || ''));
    if (isClipish) {
      const pronTok = tok === 're' ? (lower[i + 2] || '') : (lower[i + 1] || '');
      const hasPron = pronouns.has(pronTok);
      // search for terry within next 5 tokens (offset depends on whether two-token form is used)
      const start = tok === 're' ? i + 3 : i + 2;
      if (hasPron) {
        for (let k = start; k <= Math.min(lower.length - 1, start + 5); k++) {
          if (lower[k] === 'terry') {
            lastClipTriggerByUser.set(userId, now);
            transcriptHistoryByUser.set(userId, []);
            return true;
          }
        }
      }
    }
  }
  return false;
}


// --- Utility: Find the most populated voice channel (excluding users joined <1s ago) ---
function getMostPopulatedVoiceChannel(guild) {
  let maxMembers = 0;
  let targetChannel = null;
  const now = Date.now();
  guild.channels.cache.forEach(channel => {
    if (channel.type === 2) { // 2 = GUILD_VOICE
      // Skip ignored voice channels for this guild
      const gcfg = config.guilds[guild.id] || {};
      const ignored = new Set(gcfg.ignoredVoiceChannels || []);
      if (ignored.has(channel.id)) return;
      let count = 0;
      for (const [userId, member] of channel.members) {
        const joinMap = userJoinTimestamps[guild.id] || {};
        // Skip the bot itself
        if (client.user && userId === client.user.id) continue;
        // Only count users with sufficient stability
        if (joinMap[userId] && now - joinMap[userId] >= MIN_STABLE_MS) {
          count++;
        }
      }
      if (count > maxMembers) {
        maxMembers = count;
        targetChannel = channel;
      }
    }
  });
  return targetChannel;
}


// --- PCM mixing and rolling buffer for clips (currently not used, but left for future use) ---
// function mixAndBufferPcm(userBuffers, bufferSize) {
//   ...existing code...
// }

// --- Join a voice channel and monitor audio, transcribe, and handle clips ---
function leaveVoiceChannel(reason = '') {
  try {
    console.log('[voice] leaving voice channel', currentChannelId || '(none)', 'reason=', reason);
    if (monitorInterval) {
      clearInterval(monitorInterval);
      monitorInterval = null;
    }
    if (currentPlayer) {
      try { currentPlayer.stop(true); console.log('[voice] stopped currentPlayer'); } catch (e) { console.warn('[voice] currentPlayer.stop error:', e?.message); }
      currentPlayer = null;
    }
    if (currentConnection) {
      try { currentConnection.destroy(); console.log('[voice] destroyed connection'); } catch (e) { console.warn('[voice] connection.destroy error:', e?.message); }
      currentConnection = null;
    }
    currentChannelId = null;
    updateWebMembers(null);
  } catch (_) {}
}

function joinAndMonitor(channel) {
  console.log('[voice] joining channel', channel?.id, channel?.name);
  currentChannelId = channel.id;
  updateWebMembers(channel);
  currentConnection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });
  try {
    currentConnection.on('stateChange', (oldS, newS) => {
      console.log('[voice] connection stateChange:', oldS?.status, '->', newS?.status);
    });
  } catch (_) {}
  // Create or reuse an audio player for playback
  if (!currentPlayer) {
    currentPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    try {
      currentPlayer.on('stateChange', (o, n) => console.log('[voice] player stateChange:', o?.status, '->', n?.status));
      currentPlayer.on('error', (e) => console.warn('[voice] player error:', e?.message || e));
    } catch (_) {}
  }
  try { currentConnection.subscribe(currentPlayer); console.log('[voice] subscribed player to connection'); } catch (e) { console.warn('[voice] subscribe error:', e?.message); }

  // Wait until ready before starting to receive/process
  entersState(currentConnection, VoiceConnectionStatus.Ready, 15000)
    .then(() => console.log('[voice] connection Ready'))
    .catch((e) => console.warn('[voice] connection not ready:', e?.message || e));

  const receiver = currentConnection.receiver;
  const activeStreams = new Set();
  const userState = new Map(); // userId -> { name, whisperBuf: Int16Array[], lastSend: number, transcribeQueue: Promise }

  if (monitorInterval) clearInterval(monitorInterval);
  monitorInterval = setInterval(() => {
    const guild = channel.guild;
    const gcfg = config.guilds[guild.id] || {};
    const includeBots = !!gcfg.clipBots;
    for (const [userId, member] of channel.members) {
      if (client.user && userId === client.user.id) continue;
      if (!includeBots && member.user?.bot) continue;
      if (activeStreams.has(userId)) continue;

      activeStreams.add(userId);
      const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 }
      });
      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

      const name = member.user?.username || `user_${userId}`;
      if (!userState.has(userId)) {
        userState.set(userId, {
          name,
          whisperBuf: [],
          lastSend: 0,
          transcribeQueue: Promise.resolve()
        });
      }

      opusStream.pipe(decoder);
      decoder.on('data', (decoded) => {
        try {
          if (!decoded || decoded.length === 0) return;
          const pcm16 = new Int16Array(decoded.buffer, decoded.byteOffset, decoded.length / 2);
          const copy = new Int16Array(pcm16.length);
          copy.set(pcm16);
          writeToUserRing(userId, copy);
          try {
            const b64 = Buffer.from(copy.buffer).toString('base64');
            io.emit('audio', { userId, data: b64 });
          } catch (_) {}

          const st = userState.get(userId);
          if (!st) return;
          for (let i = 0; i < copy.length; i++) st.whisperBuf.push(copy[i]);
          if (st.whisperBuf.length >= MIN_CHUNK_SAMPLES_STEREO) {
            let chunk16k = downsampleTo16kMono(Int16Array.from(st.whisperBuf));
            chunk16k = normalizeToTargetRms(chunk16k, 0.1, 6.0);
            st.whisperBuf = st.whisperBuf.slice(MIN_CHUNK_SAMPLES_STEREO);
            const audioBuffer = Buffer.from(chunk16k.buffer);
            const userName = st.name;
            st.transcribeQueue = st.transcribeQueue.then(() =>
              axios.post(WHISPER_URL, audioBuffer, {
                headers: { 'Content-Type': 'application/octet-stream' },
                timeout: 20000
              }).then(res => {
                if (res.data && res.data.text) {
                  const transcriptText = String(res.data.text || '').trim();
                  if (!transcriptText) return;
                  io.emit('transcript', { userId, username: userName, text: transcriptText, timestamp: Date.now() });
                  appendTranscriptContext(userId, transcriptText);
                  if (shouldTriggerClipFromContext(userId)) {
                    handleVoiceClipCommand(userName, userId);
                  }
                }
              }).catch(() => {}));
          }

          if (!st.lastSend || Date.now() - st.lastSend > TRANSCRIBE_FLUSH_MS) {
            if (st.whisperBuf.length > (STEREO_INT16_SAMPLES_PER_SEC * 0.6)) {
              let chunk16k = downsampleTo16kMono(Int16Array.from(st.whisperBuf));
              chunk16k = normalizeToTargetRms(chunk16k, 0.1, 6.0);
              st.whisperBuf = [];
              const audioBuffer = Buffer.from(chunk16k.buffer);
              const userName = st.name;
              st.transcribeQueue = st.transcribeQueue.then(() =>
                axios.post(WHISPER_URL, audioBuffer, {
                  headers: { 'Content-Type': 'application/octet-stream' },
                  timeout: 20000
                }).then(res => {
                  if (res.data && res.data.text) {
                    const transcriptText = String(res.data.text || '').trim();
                    if (!transcriptText) return;
                    io.emit('transcript', { userId, username: userName, text: transcriptText, timestamp: Date.now() });
                    appendTranscriptContext(userId, transcriptText);
                    if (shouldTriggerClipFromContext(userId)) {
                      handleVoiceClipCommand(userName, userId);
                    }
                  }
                }).catch(() => {}));
            }
            st.lastSend = Date.now();
          }
        } catch (_) {}
      });
      decoder.on('end', () => { activeStreams.delete(userId); });
      decoder.on('error', () => { activeStreams.delete(userId); });
    }
  }, 2000);
  // Note: This implementation focuses on per-user buffers and Whisper streaming.
}

// (No client-side repetition collapsing; show raw model output).


// --- Update web UI with current channel and members ---
function updateWebMembers(channel) {
  if (!channel) {
    currentMembers = [];
    io.emit('update', {
      channel: null,
      members: []
    });
    return;
  }
  currentMembers = Array.from(channel.members.values()).map(m => ({
    id: m.id,
    username: m.user.username,
    avatar: m.user.displayAvatarURL()
  }));
  io.emit('update', {
    channel: { id: channel.id, name: channel.name },
    members: currentMembers
  });
}


// --- Web server static files ---
app.use(express.static('public'));
// Serve clips statically
app.use('/clips', express.static(path.join(__dirname, 'public', 'clips')));


// --- Socket.io: Send current channel/members on connection ---
io.on('connection', (socket) => {
  console.log('[ws] client connected');
  let channelObj = null;
  if (currentChannelId) {
    const guild = client.guilds.cache.first();
    if (guild) {
      const channel = guild.channels.cache.get(currentChannelId);
      if (channel) {
        channelObj = { id: channel.id, name: channel.name };
      }
    }
  }
  socket.emit('update', {
    channel: channelObj,
    members: currentMembers
  });
  // Backfill recent events
  try {
    socket.emit('transcripts_recent', recentTranscripts.slice(-100));
    const sortedClips = recentClips.slice().sort((a,b) => b.timestamp - a.timestamp);
    socket.emit('clips_recent', sortedClips);
  } catch (_) {}

  // Clip button: throttle requests per socket to avoid spam
  let lastClipReq = 0;
  socket.on('clip_request', async (payload) => {
    const now = Date.now();
    if (now - lastClipReq < 5000) return; // 5s cooldown per client
    lastClipReq = now;
    try {
      const botName = client.user?.username || 'Bot';
      const botId = client.user?.id || '0';
      const title = payload && typeof payload.title === 'string' ? payload.title : '';
      await handleVoiceClipCommand(botName, botId, title);
    } catch (_) {}
  });

  // Web-initiated playback: upload binary and stream into Discord via ffmpeg (prism-media)
  let lastPlayReq = 0;
  socket.on('play_upload', async (payload) => {
    try {
      const now = Date.now();
      if (now - lastPlayReq < 3000) return; // cooldown 3s per client
      lastPlayReq = now;
      const dataLen = payload && payload.data && payload.data.length ? payload.data.length : 0;
      const mime = payload && typeof payload.mime === 'string' ? payload.mime : 'unknown';
      console.log(`[play] request received: bytes=${dataLen} mime=${mime}`);
      if (!payload || !payload.data || typeof payload.mime !== 'string') {
        console.warn('[play] invalid payload');
        try { socket.emit('play_error', 'Invalid file payload'); } catch (_) {}
        return;
      }
      if (!currentConnection) {
        console.warn('[play] no currentConnection (bot not in voice channel)');
        try { socket.emit('play_error', 'Bot is not in a voice channel'); } catch (_) {}
        return;
      }
      // Ensure voice connection is Ready before playback
      try {
        await entersState(currentConnection, VoiceConnectionStatus.Ready, 10000);
      } catch (e) {
        console.warn('[play] connection not Ready:', e?.message || e);
        try { socket.emit('play_error', 'Voice connection not ready'); } catch (_) {}
        return;
      }
      if (!currentPlayer) {
        currentPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
        console.log('[play] created AudioPlayer');
        try { currentConnection.subscribe(currentPlayer); console.log('[play] subscribed player to connection'); } catch (e) { console.warn('[play] subscribe failed:', e?.message); }
      }
  const buf = toNodeBuffer(payload.data);
  if (!buf || buf.length === 0) {
    console.warn('[play] could not convert upload to buffer');
    try { socket.emit('play_error', 'Failed to read uploaded bytes'); } catch (_) {}
    return;
  }
  // Save upload to disk
  const uploadsDir = path.join(__dirname, 'public', 'uploads');
  try { if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true }); } catch (e) { console.warn('[play] mkdir uploads failed:', e?.message); }
  const rawName = (payload && typeof payload.name === 'string') ? payload.name : 'upload';
  const safeBase = String(rawName).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'upload';
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const fileName = `${unique}_${safeBase}`;
  const filePath = path.join(uploadsDir, fileName);
  await fs.promises.writeFile(filePath, buf);
      console.log('[play] saved upload to', filePath, 'size=', buf.length);
      // Emit a URL so client can see where it landed
      try {
        const url = `/uploads/${fileName}`;
        socket.emit('play_saved', { url, name: safeBase });
      } catch (_) {}
      // Play from disk using helper, emit events, then delete file
      playFileFromDisk(
        filePath,
        () => { try { socket.emit('play_started'); } catch (_) {} },
        () => {
          try { socket.emit('play_ended'); } catch (_) {}
          if (process.env.KEEP_UPLOADS === '1') {
            console.log('[play] KEEP_UPLOADS=1 set; skipping delete after end for', filePath);
          } else {
            fs.unlink(filePath, (err) => {
              if (err) console.warn('[play] failed to delete after end:', err?.message || err);
              else console.log('[play] deleted upload file after end', filePath);
            });
          }
        },
        (err) => {
          console.warn('[play] playback error:', err?.message || err);
          try { socket.emit('play_error', String(err?.message || 'playback error')); } catch (_) {}
          if (process.env.KEEP_UPLOADS === '1') {
            console.log('[play] KEEP_UPLOADS=1 set; skipping delete after error for', filePath);
          } else {
            fs.unlink(filePath, (e2) => {
              if (e2) console.warn('[play] failed to delete after error:', e2?.message || e2);
              else console.log('[play] deleted upload file after error', filePath);
            });
          }
        }
      );
    } catch (e) {
      console.warn('[play] exception:', e?.message || e);
      try { socket.emit('play_error', String((e && e.message) || 'playback error')); } catch (_) {}
    }
  });
});

// --- Text command: -clip mirrors "terry clip that" ---
client.on('messageCreate', async (message) => {
  try {
    if (!message || message.author?.bot) return;
    if (!message.guild) return;
    const content = String(message.content || '').trim().toLowerCase();
    // Help: list all commands and voice trigger
    if (content === '-help' || content === '-commands') {
      const helpText = [
        '**Commands**',
        '- -help | -commands: Show this help',
  '- -clip [title]: Create a 30s clip of recent voice with optional title (DM if toggled, else post to clip channel)',
    '- -beep: Play a short test beep in the current voice channel (diagnostics)',
        '- -playserver <filename>: Play a file that already exists under public/uploads',
        '- -playlast: Play the most recently uploaded file from public/uploads',
        '- -dmtoggle: Toggle DM delivery of clips for yourself',
        '- -setclip <channel_id|#mention>: Server owner only, sets the text channel to post clips',
  '- -ignorevc <channel_id|#mention>: Server owner only, ignore a voice channel for auto-join',
  '- -unignorevc <channel_id|#mention>: Server owner only, remove a voice channel from ignore list',
  '- -listignorevc: List ignored voice channels',
  '- -clipbots: Server owner only, toggle including bot users in recorded clips',
        '',
        '**Voice trigger**',
        '- Say "terry clip that" to create a 30s clip',
        '- Also works with common variants like: "terry clip", "okay terry, clip that", or split phrases like "all right, terry" then "you click that" within a few seconds',
      ].join('\n');
      try { await message.reply(helpText); } catch (_) {}
      return;
    }

    if (content === '-beep') {
      try {
        if (!currentConnection) { await message.reply('Not in a voice channel.'); return; }
        if (!currentPlayer) {
          currentPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
          try { currentConnection.subscribe(currentPlayer); } catch (_) {}
        }
        const sampleRate = 48000; const channels = 2; const sec = 1.0; const frames = Math.floor(sampleRate * sec);
        const buf = Buffer.alloc(frames * channels * 2);
        const freq = 880; // 880 Hz beep
        for (let i = 0; i < frames; i++) {
          const t = i / sampleRate; const s = Math.sin(2 * Math.PI * freq * t);
          const v = Math.max(-1, Math.min(1, s)) * 0.4; // -8 dBFS approx
          const i16 = Math.round(v * 32767);
          buf.writeInt16LE(i16, (i * channels + 0) * 2);
          buf.writeInt16LE(i16, (i * channels + 1) * 2);
        }
        const pcmStream = Readable.from(buf);
        const enc = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
        const opus = pcmStream.pipe(enc);
        const res = createAudioResource(opus, { inputType: StreamType.Opus });
        currentPlayer.play(res);
        await message.reply('Beep sent. If you do not hear it, check voice permissions and logs.');
      } catch (e) {
        try { await message.reply('Failed to beep: ' + (e?.message || e)); } catch (_) {}
      }
      return;
    }

    // Play a file that already exists on the server under public/uploads
    if (content.startsWith('-playserver')) {
      try {
        if (!currentConnection) { await message.reply('Not in a voice channel.'); return; }
        if (!currentPlayer) {
          currentPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
          try { currentConnection.subscribe(currentPlayer); } catch (_) {}
        }
        const parts = String(message.content || '').trim().split(/\s+/);
        if (parts.length < 2) { await message.reply('Usage: -playserver <filename-in-uploads>'); return; }
        const name = parts[1].replace(/[^a-zA-Z0-9._-]+/g, '_');
        const filePath = path.join(__dirname, 'public', 'uploads', name);
        if (!fs.existsSync(filePath)) { await message.reply('File not found: ' + name); return; }
        await message.reply('Playing server file: ' + name);
        console.log('[playserver] spawning ffmpeg for PCM decode (raw s16le):', filePath);
        const ff = spawn('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-re', '-i', filePath,
          '-vn', '-sn', '-dn',
          '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        ff.stderr.on('data', d => {
          const s = d.toString();
          if (s.trim()) console.warn('[playserver][ffmpeg]', s.trim());
        });
        ff.on('close', (code, signal) => {
          console.log('[playserver] ffmpeg exited code', code, 'signal', signal);
        });
  const pcm = ff.stdout;
  const enc = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  enc.on('error', (e) => console.warn('[playserver] opus encoder error:', e?.message || e));
  const opus = pcm.pipe(enc);
  const resource = createAudioResource(opus, { inputType: StreamType.Opus });
  currentPlayer.play(resource);
      } catch (e) {
        try { await message.reply('Failed to playserver: ' + (e?.message || e)); } catch (_) {}
      }
      return;
    }

    // Play the most recently uploaded file from public/uploads
    if (content === '-playlast' || content === '-playlatest') {
      try {
        if (!currentConnection) { await message.reply('Not in a voice channel.'); return; }
        if (!currentPlayer) {
          currentPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
          try { currentConnection.subscribe(currentPlayer); } catch (_) {}
        }
        const uploadsDir = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(uploadsDir)) { await message.reply('No uploads directory found.'); return; }
        const entries = await fs.promises.readdir(uploadsDir);
        if (!entries || entries.length === 0) { await message.reply('No files found in uploads.'); return; }
        // Build {name, mtimeMs} list and pick newest regular file
        const files = [];
        for (const name of entries) {
          const full = path.join(uploadsDir, name);
          try {
            const st = await fs.promises.stat(full);
            if (st.isFile()) files.push({ name, path: full, mtimeMs: st.mtimeMs });
          } catch (_) {}
        }
        if (files.length === 0) { await message.reply('No files found in uploads.'); return; }
        files.sort((a,b) => b.mtimeMs - a.mtimeMs);
        const chosen = files[0];
        await message.reply('Playing latest upload: ' + chosen.name);
        console.log('[playlast] spawning ffmpeg for PCM decode (raw s16le):', chosen.path);
        const ff = spawn('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-re', '-i', chosen.path,
          '-vn', '-sn', '-dn',
          '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        ff.stderr.on('data', d => {
          const s = d.toString();
          if (s.trim()) console.warn('[playlast][ffmpeg]', s.trim());
        });
        ff.on('close', (code, signal) => {
          console.log('[playlast] ffmpeg exited code', code, 'signal', signal);
        });
        const pcm = ff.stdout;
        const enc = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
        enc.on('error', (e) => console.warn('[playlast] opus encoder error:', e?.message || e));
        const opus = pcm.pipe(enc);
        const resource = createAudioResource(opus, { inputType: StreamType.Opus });
        currentPlayer.play(resource);
      } catch (e) {
        try { await message.reply('Failed to playlast: ' + (e?.message || e)); } catch (_) {}
      }
      return;
    }

    // Owner-only: ignore a voice channel for auto-join
    if (content.startsWith('-ignorevc')) {
      if (message.guild.ownerId !== message.author.id) {
        try { await message.reply('You must be the server owner to use this.'); } catch (_) {}
        return;
      }
      const arg = String(message.content || '').trim().split(/\s+/)[1] || '';
      const match = arg && arg.match(/^(?:<#)?(\d{10,})(?:>)?$/);
      if (!match) {
        try { await message.reply('Usage: -ignorevc <channel_id or #mention>'); } catch (_) {}
        return;
      }
      const chanId = match[1];
      const ch = message.guild.channels.cache.get(chanId);
      if (!ch || ch.type !== 2) { // 2 = GUILD_VOICE
        try { await message.reply('That is not a voice channel.'); } catch (_) {}
        return;
      }
      if (!config.guilds[message.guild.id]) config.guilds[message.guild.id] = {};
      if (!config.guilds[message.guild.id].ignoredVoiceChannels) config.guilds[message.guild.id].ignoredVoiceChannels = [];
      const list = config.guilds[message.guild.id].ignoredVoiceChannels;
      if (!list.includes(chanId)) list.push(chanId);
      saveConfig();
      try { await message.reply(`Ignored voice channel: <#${chanId}>`); } catch (_) {}
      if (currentChannelId === chanId) {
        leaveVoiceChannel('ignored');
      }
    }

    // Owner-only: unignore a voice channel
    if (content.startsWith('-unignorevc')) {
      if (message.guild.ownerId !== message.author.id) {
        try { await message.reply('You must be the server owner to use this.'); } catch (_) {}
        return;
      }
      const arg = String(message.content || '').trim().split(/\s+/)[1] || '';
      const match = arg && arg.match(/^(?:<#)?(\d{10,})(?:>)?$/);
      if (!match) {
        try { await message.reply('Usage: -unignorevc <channel_id or #mention>'); } catch (_) {}
        return;
      }
      const chanId = match[1];
      if (!config.guilds[message.guild.id]) config.guilds[message.guild.id] = {};
      const list = config.guilds[message.guild.id].ignoredVoiceChannels || [];
      const idx = list.indexOf(chanId);
      if (idx !== -1) {
        list.splice(idx, 1);
        config.guilds[message.guild.id].ignoredVoiceChannels = list;
        saveConfig();
        try { await message.reply(`Unignored voice channel: <#${chanId}>`); } catch (_) {}
      } else {
        try { await message.reply('That channel was not ignored.'); } catch (_) {}
      }
    }

    // List ignored voice channels
    if (content === '-listignorevc') {
      const gcfg = config.guilds[message.guild.id] || {};
      const list = gcfg.ignoredVoiceChannels || [];
      if (!list.length) {
        try { await message.reply('No ignored voice channels.'); } catch (_) {}
        return;
      }
      const names = list.map(id => {
        const ch = message.guild.channels.cache.get(id);
        return ch ? `• ${ch.name} (<#${id}>)` : `• <#${id}>`;
      }).join('\n');
      try { await message.reply(`Ignored voice channels:\n${names}`); } catch (_) {}
    }

    // Toggle including bot users in clips (server owner only)
    if (content === '-clipbots') {
      if (message.guild.ownerId !== message.author.id) {
        try { await message.reply('You must be the server owner to use this.'); } catch (_) {}
        return;
      }
      if (!config.guilds[message.guild.id]) config.guilds[message.guild.id] = {};
      const cur = !!config.guilds[message.guild.id].clipBots;
      config.guilds[message.guild.id].clipBots = !cur;
      saveConfig();
      try { await message.reply(`Include bot users in clips: ${!cur ? 'ON' : 'OFF'}`); } catch (_) {}
      return;
    }
    if (content === '-clip' || content.startsWith('-clip ')) {
      const raw = String(message.content || '').trim();
      const idx = raw.indexOf(' ');
      const title = idx > 0 ? raw.slice(idx + 1).trim() : '';
      handleVoiceClipCommand(message.author.username, message.author.id, title);
      try { await message.react('🎬'); } catch (_) {}
    }
    // Toggle DM delivery of clips for this user (default off)
    if (content === '-dmtoggle') {
      const uid = message.author.id;
      const newVal = !config.dmPrefs[uid];
      config.dmPrefs[uid] = newVal;
      saveConfig();
      try { await message.reply(newVal ? 'DM clips: ON' : 'DM clips: OFF'); } catch (_) {}
    }
    // Owner-only: set the guild clip channel id
    if (content.startsWith('-setclip')) {
      // Only server owner may set
      if (message.guild.ownerId !== message.author.id) {
        try { await message.reply('You must be the server owner to use this.'); } catch (_) {}
        return;
      }
      // Extract channel id (accept mention like <#id> or raw id)
      const arg = String(message.content || '').trim().split(/\s+/)[1] || '';
      const match = arg.match(/^(?:<#)?(\d{10,})(?:>)?$/);
      if (!match) {
        try { await message.reply('Usage: -setclip <channel_id or #mention>'); } catch (_) {}
        return;
      }
      const chanId = match[1];
      const ch = message.guild.channels.cache.get(chanId);
      if (!ch || !(typeof ch.isTextBased === 'function' && ch.isTextBased())) {
        try { await message.reply('That channel is not a text channel I can post to.'); } catch (_) {}
        return;
      }
      if (!config.guilds[message.guild.id]) config.guilds[message.guild.id] = {};
      config.guilds[message.guild.id].clipChannelId = chanId;
      saveConfig();
      try { await message.reply(`Clip channel set to <#${chanId}>`); } catch (_) {}
    }
  } catch (_) {}
});



// --- Periodically check for eligible channels to join (in case no voiceStateUpdate fires) ---
setInterval(() => {
  const guild = client.guilds.cache.first();
  if (!guild) return;
  if (!userJoinTimestamps[guild.id]) userJoinTimestamps[guild.id] = {};
  const now = Date.now();
  // For all voice channels, set join timestamps for users if not already set
  guild.channels.cache.forEach(channel => {
    if (channel.type === 2) {
      for (const [userId, member] of channel.members) {
        if (!userJoinTimestamps[guild.id][userId]) {
          userJoinTimestamps[guild.id][userId] = now;
        }
      }
    }
  });
  const channel = getMostPopulatedVoiceChannel(guild);
  // If currently connected, check if we became alone; if so, leave
  if (currentChannelId) {
    const curr = guild.channels.cache.get(currentChannelId);
    if (!curr || (curr.members && Array.from(curr.members.values()).filter(m => m.id !== client.user.id).length === 0)) {
      leaveVoiceChannel('periodic-empty');
    }
  }
  // Only join if not already in a channel and eligible users are present and stable
  if (!currentChannelId && channel && channel.members && channel.members.size > 0) {
    const botId = client.user.id;
    const now2 = Date.now();
    const realMembers = Array.from(channel.members.values()).filter(m => m.id !== botId);
    const joinMap = userJoinTimestamps[guild.id] || {};
    const hasStable = realMembers.some(m => joinMap[m.id] && (now2 - joinMap[m.id]) >= MIN_STABLE_MS);
    if (realMembers.length > 0 && hasStable) {
      joinAndMonitor(channel);
    }
  }
  // Always update web members for the current channel
  if (currentChannelId) {
    const channel = guild.channels.cache.get(currentChannelId);
    if (channel) updateWebMembers(channel);
  }
}, 2000);



// --- Start web server and Discord client ---
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(PORT, () => {
  console.log(`Web server running on http://localhost:${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);
