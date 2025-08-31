

// --- Imports and Setup ---
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
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

// Optional env config (defaults to simple IP; POST / is accepted by the server)
const WHISPER_URL = process.env.WHISPER_URL || 'http://127.0.0.1:5005';

// Discord client setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let monitorInterval;

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
const CLIP_SECONDS = 30;
const CLIP_SAMPLE_RATE = 48000;
const CLIP_CHANNELS = 2;
const CLIP_BYTES_PER_SAMPLE = 2; // 16-bit PCM
let lastClipInfo = null; // { filename, username, timestamp }
// Require users to be in a channel this long before we consider joining (ms)
const MIN_STABLE_MS = 3000;
// Mix gain for channel-wide accumulation (leave at 1.0; export normalizes if clipping)
const MIX_ATTENUATION = 1.0;
// (No edge smoothing; keep pipeline simple for maximum fidelity)

// --- Channel-wide mixed ring buffer (represents actual timeline of the channel) ---
const CHANNEL_RING_LENGTH = CLIP_SAMPLE_RATE * CLIP_CHANNELS * CLIP_SECONDS; // stereo Int16 samples count
let channelRing = new Int32Array(CHANNEL_RING_LENGTH); // accumulate in 32-bit to avoid clipping during mix
let channelWriteIndex = 0; // next position for newest time
let channelClock = null;
// Track per-user last write position for continuity
const userMixState = new Map(); // userId -> lastIdx (position after last written sample)

function startChannelTimeline() {
  if (channelClock) clearInterval(channelClock);
  channelRing = new Int32Array(CHANNEL_RING_LENGTH);
  channelWriteIndex = 0;
  userMixState.clear();
  const sps = CLIP_SAMPLE_RATE * CLIP_CHANNELS;
  const TICK_MS = 20; // align with typical Opus frame duration to reduce boundary artifacts
  const SAMPLES_PER_TICK = Math.floor((sps * TICK_MS) / 1000);
  channelClock = setInterval(() => {
    for (let i = 0; i < SAMPLES_PER_TICK; i++) {
      channelRing[channelWriteIndex] = 0;
      channelWriteIndex++;
      if (channelWriteIndex >= CHANNEL_RING_LENGTH) channelWriteIndex = 0;
    }
  }, TICK_MS);
}

function stopChannelTimeline() {
  if (channelClock) {
    clearInterval(channelClock);
    channelClock = null;
  }
}

// Overlay a decoded Int16Array pcm chunk so that its end aligns with the current time
function mixUserIntoChannelRing(userId, pcmInt16) {
  if (!pcmInt16 || pcmInt16.length === 0) return;
  // Determine a start index that is continuous for this user but never in the future
  let start;
  const len = CHANNEL_RING_LENGTH;
  if (userMixState.has(userId)) {
    start = userMixState.get(userId);
    // If start is too far ahead of channelWriteIndex (i.e., writing into the future), realign to end
    const forward = start <= channelWriteIndex ? (channelWriteIndex - start) : (len - start + channelWriteIndex);
    if (forward > pcmInt16.length) {
      // The user's next chunk would land too far in the past; keep continuity
    } else {
      // Would write into the future; re-align chunk end with current time
      start = channelWriteIndex - pcmInt16.length;
      while (start < 0) start += len;
    }
  } else {
    // First chunk for user: align end with current time
    start = channelWriteIndex - pcmInt16.length;
    while (start < 0) start += len;
  }
  let idx = start;
  for (let p = 0; p < pcmInt16.length; p++) {
    if (idx >= len) idx = 0;
    channelRing[idx] = channelRing[idx] + (pcmInt16[p] * MIX_ATTENUATION);
    idx++;
  }
  userMixState.set(userId, idx >= len ? 0 : idx);
}

function getLast30sChannelMix() {
  const tmp = new Int32Array(CHANNEL_RING_LENGTH);
  const firstPart = CHANNEL_RING_LENGTH - channelWriteIndex;
  tmp.set(channelRing.subarray(channelWriteIndex), 0);
  if (channelWriteIndex > 0) tmp.set(channelRing.subarray(0, channelWriteIndex), firstPart);
  // Peak detect for optional normalization
  let peak = 0;
  for (let i = 0; i < tmp.length; i++) {
    const v = Math.abs(tmp[i] | 0);
    if (v > peak) peak = v;
  }
  const target = 31000; // small headroom under 32767
  const scale = peak > 32767 ? (target / peak) : 1;
  const out = new Int16Array(CHANNEL_RING_LENGTH);
  if (scale !== 1) {
    for (let i = 0; i < tmp.length; i++) {
      let v = Math.round(tmp[i] * scale);
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      out[i] = v;
    }
  } else {
    for (let i = 0; i < tmp.length; i++) {
      let v = tmp[i];
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      out[i] = v;
    }
  }
  return out;
}
 

// Per-user rolling ring buffers for 30s of 48kHz stereo Int16 PCM
const TOTAL_CLIP_SAMPLES = CLIP_SAMPLE_RATE * CLIP_CHANNELS * CLIP_SECONDS; // Int16 samples (not bytes)
// userId -> { buffer: Int16Array, writeIndex: number, filled: number, lastWriteTimeMs: number }
const userRings = new Map();

function writeToUserRing(userId, pcm16Stereo) {
  let ring = userRings.get(userId);
  if (!ring) {
    ring = { buffer: new Int16Array(TOTAL_CLIP_SAMPLES), writeIndex: 0, filled: 0, lastWriteTimeMs: 0 };
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
  ring.lastWriteTimeMs = Date.now();
}


// Create and send a 30s clip of the current voice channel mix
async function handleVoiceClipCommand(requestedByName, requestedById) {
  try {
    const guild = client.guilds.cache.first();
    if (!guild || !currentChannelId) return;
    const voiceChan = guild.channels.cache.get(currentChannelId);
    if (!voiceChan) return;
    // Include all users who have spoken within the last 30s, even if they left the channel
    const now = Date.now();
    const cutoff = CLIP_SECONDS * 1000;
    const botId = client.user?.id;
    const memberIds = Array.from(userRings.entries())
      .filter(([uid, ring]) => uid !== botId && ring && ring.filled > 0 && (now - (ring.lastWriteTimeMs || 0)) <= cutoff)
      .map(([uid]) => uid);
    if (memberIds.length === 0) return;
  // Use the channel-wide mixed ring to get the real last 30s of the room
  const mixed = getLast30sChannelMix();
    // Ensure output directory exists
    const clipsDir = path.join(__dirname, 'public', 'clips');
    if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });
  // Unique filename to survive rapid successive clip requests
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const filePath = path.join(clipsDir, `clip_${unique}.wav`);

    // Write WAV using wav.Writer
    await new Promise((resolve, reject) => {
      const writer = new wav.Writer({ channels: CLIP_CHANNELS, sampleRate: CLIP_SAMPLE_RATE, bitDepth: 16 });
      const out = fs.createWriteStream(filePath);
      writer.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      writer.pipe(out);
  writer.write(Buffer.from(mixed.buffer, mixed.byteOffset, mixed.byteLength));
      writer.end();
    });

    lastClipInfo = { filename: path.basename(filePath), username: requestedByName, timestamp: Date.now() };
    io.emit('new_clip', lastClipInfo);

    let delivered = false;
    // If the user has DM toggle enabled, try to send the clip to their DMs
    const dmOn = !!config.dmPrefs[requestedById];
    if (dmOn) {
      try {
        const user = await client.users.fetch(requestedById);
        await user.send({ content: `Here is your clip, ${requestedByName}`, files: [filePath] });
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
          await clipsText.send({ content: `Clip requested by ${requestedByName}` , files: [filePath] });
          delivered = true;
        } catch (_) { /* ignore send errors */ }
      }
    }

    // Delete the local file after successful delivery
    if (delivered) {
      try { await fs.promises.unlink(filePath); } catch (_) {}
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
    if (monitorInterval) {
      clearInterval(monitorInterval);
      monitorInterval = null;
    }
  stopChannelTimeline();
  userMixState.clear();
    if (currentConnection) {
      try { currentConnection.destroy(); } catch (_) {}
      currentConnection = null;
    }
    currentChannelId = null;
    updateWebMembers(null);
  } catch (_) {}
}

function joinAndMonitor(channel) {
  currentChannelId = channel.id;
  updateWebMembers(channel);
  currentConnection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator
  });
  // Start channel timeline for mixed ring
  startChannelTimeline();
  // Handle receiver-level errors (e.g., DAVE decryption hiccups)
  try {
    currentConnection.receiver.on('error', (err) => {
      console.warn('[voice receiver error]', err && err.code ? err.code : String(err));
    });
  } catch (_) {}

  // Clear previous interval if any
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }

  // Track which user streams are already being handled
  const activeStreams = new Set();
  monitorInterval = setInterval(() => {
    // If no non-bot members remain in the channel, leave
    const botId = client.user?.id;
    const nonBots = Array.from(channel.members.values()).filter(m => m.id !== botId);
    if (nonBots.length === 0) {
      leaveVoiceChannel('alone');
      return;
    }

    for (const [userId, member] of channel.members) {
      if (!activeStreams.has(userId)) {
        activeStreams.add(userId);
        const opusStream = currentConnection.receiver.subscribe(userId, {
          end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: 1000
          }
        });
        // Decode Opus to PCM S16LE using prism-media (robust, smoother timing)
        const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        opusStream.pipe(decoder);
        const userName = member.user.username;
        decoder.on('data', (pcm) => {
          try {
            // Send PCM as base64 to browser
            io.emit('audio', {
              userId,
              data: Buffer.from(pcm).toString('base64')
            });
            // --- Accumulate PCM, downsample to 16kHz mono, send as soon as enough is buffered ---
            if (!member.whisperPcmBuffer) member.whisperPcmBuffer = [];
            // Convert to Int16Array
            const pcm16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
            // Also mix into the channel-wide ring with per-user continuity to preserve natural speech
            mixUserIntoChannelRing(userId, pcm16);
            // Write decoded 48kHz stereo PCM into the user's 30s ring buffer for clipping
            writeToUserRing(userId, pcm16);
            member.whisperPcmBuffer.push(...pcm16);
            // Helper: Downsample 48kHz stereo Int16Array to 16kHz mono Int16Array
            function downsampleTo16kMono(input) {
              // input: Int16Array, stereo interleaved, 48kHz
              const outLen = Math.floor(input.length / 6); // 2 channels * 3x downsample
              const out = new Int16Array(outLen);
              for (let i = 0, j = 0; j < outLen; j++, i += 6) {
                // Average L+R for mono, every 3rd sample (48kHz->16kHz)
                const l1 = input[i], r1 = input[i+1], l2 = input[i+2], r2 = input[i+3], l3 = input[i+4], r3 = input[i+5];
                out[j] = Math.floor((l1 + r1 + l2 + r2 + l3 + r3) / 6);
              }
              return out;
            }

            // Helper: Normalize Int16 mono to target RMS to improve Whisper robustness
            function normalizeToTargetRms(int16, targetRms = 0.1, maxGain = 6.0) {
              // Convert to float, compute RMS
              let sumSq = 0;
              for (let i = 0; i < int16.length; i++) {
                const f = int16[i] / 32768;
                sumSq += f * f;
              }
              const rms = Math.sqrt(sumSq / Math.max(1, int16.length));
              if (rms < 1e-6) return int16; // silence: don't boost noise
              let gain = targetRms / rms;
              if (gain > maxGain) gain = maxGain;
              if (Math.abs(gain - 1.0) < 1e-3) return int16; // close enough
              const out = new Int16Array(int16.length);
              for (let i = 0; i < int16.length; i++) {
                let v = (int16[i] / 32768) * gain;
                // Hard clip guard
                if (v > 1) v = 1; else if (v < -1) v = -1;
                out[i] = Math.round(v * 32767);
              }
              return out;
            }
    // --- Ensure jobs are sent in order: queue and await each request per user ---
            if (!member.transcribeQueue) member.transcribeQueue = Promise.resolve();
            // Only send if we have at least MIN_CHUNK_SAMPLES_STEREO (~0.8s)
            while (member.whisperPcmBuffer.length >= MIN_CHUNK_SAMPLES_STEREO) {
              let chunk16k = downsampleTo16kMono(member.whisperPcmBuffer.slice(0, MIN_CHUNK_SAMPLES_STEREO));
              // Normalize to ~-20 dBFS RMS for Whisper
              chunk16k = normalizeToTargetRms(chunk16k, 0.1, 6.0);
              member.whisperPcmBuffer = member.whisperPcmBuffer.slice(MIN_CHUNK_SAMPLES_STEREO);
              const audioBuffer = Buffer.from(chunk16k.buffer);
              member.transcribeQueue = member.transcribeQueue.then(() =>
                axios.post(WHISPER_URL, audioBuffer, {
                  headers: { 'Content-Type': 'application/octet-stream' },
                  timeout: 20000
                }).then(res => {
      if (res.data && res.data.text) {
                    const transcriptText = String(res.data.text || '').trim();
                    if (!transcriptText) return;
                    io.emit('transcript', {
                      userId,
                      username: userName,
                      text: transcriptText,
                      timestamp: Date.now()
                    });
                    // Add to short context and check flexible trigger phrases
                    appendTranscriptContext(userId, transcriptText);
                    if (shouldTriggerClipFromContext(userId)) {
                      handleVoiceClipCommand(userName, userId);
                    }
                  }
                }).catch(() => {}));
            }
            // Also, if > TRANSCRIBE_FLUSH_MS since last send, flush whatever is buffered
            if (!member.lastWhisperSend || Date.now() - member.lastWhisperSend > TRANSCRIBE_FLUSH_MS) {
              // Avoid flushing small fragments; require at least ~0.6s of buffered audio
              if (member.whisperPcmBuffer.length > (STEREO_INT16_SAMPLES_PER_SEC * 0.6)) {
                let chunk16k = downsampleTo16kMono(member.whisperPcmBuffer);
                // Normalize to ~-20 dBFS RMS for Whisper
                chunk16k = normalizeToTargetRms(chunk16k, 0.1, 6.0);
                member.whisperPcmBuffer = [];
                const audioBuffer = Buffer.from(chunk16k.buffer);
                member.transcribeQueue = member.transcribeQueue.then(() =>
                  axios.post(WHISPER_URL, audioBuffer, {
                    headers: { 'Content-Type': 'application/octet-stream' },
                    timeout: 20000
                  }).then(res => {
        if (res.data && res.data.text) {
                      const transcriptText = String(res.data.text || '').trim();
                      if (!transcriptText) return;
                      io.emit('transcript', {
                        userId,
                        username: userName,
                        text: transcriptText,
                        timestamp: Date.now()
                      });
                      appendTranscriptContext(userId, transcriptText);
                      if (shouldTriggerClipFromContext(userId)) {
                        handleVoiceClipCommand(userName, userId);
                      }
                    
                    }
                  }).catch(() => {}));
              }
              member.lastWhisperSend = Date.now();
            }
          } catch (e) {
            // Skip bad frames to avoid static artifacts
          }
        });

        decoder.on('end', () => {
          activeStreams.delete(userId);
        });
        decoder.on('error', () => {
          // Skip decoder errors
          activeStreams.delete(userId);
        });
  // No additional per-stream error handlers to keep audio path identical to prior version
      }
    }
  }, 2000); // Check every 2 seconds for new users
  // Note: Browser-side decoding of Opus is required for playback.
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
        '- -clip: Create a 30s clip of recent voice (DM if toggled, else post to clip channel)',
        '- -dmtoggle: Toggle DM delivery of clips for yourself',
        '- -setclip <channel_id|#mention>: Server owner only, sets the text channel to post clips',
  '- -ignorevc <channel_id|#mention>: Server owner only, ignore a voice channel for auto-join',
  '- -unignorevc <channel_id|#mention>: Server owner only, remove a voice channel from ignore list',
  '- -listignorevc: List ignored voice channels',
        '',
        '**Voice trigger**',
        '- Say "terry clip that" to create a 30s clip',
        '- Also works with common variants like: "terry clip", "okay terry, clip that", or split phrases like "all right, terry" then "you click that" within a few seconds',
      ].join('\n');
      try { await message.reply(helpText); } catch (_) {}
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
    if (content === '-clip' || content.startsWith('-clip ')) {
      handleVoiceClipCommand(message.author.username, message.author.id);
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
