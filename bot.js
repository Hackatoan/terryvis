

// --- Imports and Setup ---
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const wav = require('wav');
const axios = require('axios');
const { OpusEncoder } = require('@discordjs/opus');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// Express and Socket.io setup
const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
const CLIP_SECONDS = 30;
const CLIP_SAMPLE_RATE = 48000;
const CLIP_CHANNELS = 2;
const CLIP_BYTES_PER_SAMPLE = 2; // 16-bit PCM
const CLIP_BUFFER_SIZE = CLIP_SAMPLE_RATE * CLIP_CHANNELS * CLIP_BYTES_PER_SAMPLE * CLIP_SECONDS;
let rollingPcmBuffer = Buffer.alloc(0); // legacy, not used by new ring-mix path
let lastClipInfo = null; // { filename, username, timestamp }

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

function getLast30sMix(memberIds) {
  const total = new Int16Array(TOTAL_CLIP_SAMPLES); // zero-initialized
  for (const userId of memberIds) {
    const ring = userRings.get(userId);
    if (!ring) continue;
    const buf = ring.buffer;
    const validLen = Math.min(TOTAL_CLIP_SAMPLES, ring.filled || 0);
    if (validLen <= 0) continue;
    // Compute where this user's latest sample should land relative to now, based on wall-clock
    const nowMs = Date.now();
    const sr = CLIP_SAMPLE_RATE * CLIP_CHANNELS; // samples per second (stereo)
    const sinceMs = Math.max(0, nowMs - (ring.lastWriteTimeMs || nowMs));
    let offsetSamples = Math.floor((sinceMs / 1000) * sr);
    if (offsetSamples < 0) offsetSamples = 0;
    if (offsetSamples > TOTAL_CLIP_SAMPLES) offsetSamples = TOTAL_CLIP_SAMPLES;

    // Source window in ring (oldest -> newest)
    let srcStart = ring.writeIndex - validLen;
    if (srcStart < 0) srcStart += buf.length;
    // Desired destination end index (exclusive)
    let dstEnd = TOTAL_CLIP_SAMPLES - offsetSamples;
    if (dstEnd <= 0) continue; // all content is outside the 30s window
    let dstStart = dstEnd - validLen;
    let copyLen = validLen;
    // If the start is before 0, trim the leading part from the source
    if (dstStart < 0) {
      const drop = -dstStart;
      // advance srcStart by 'drop' samples with wrap
      srcStart += drop;
      if (srcStart >= buf.length) srcStart -= buf.length * Math.floor(srcStart / buf.length);
      copyLen -= drop;
      dstStart = 0;
      if (copyLen <= 0) continue;
    }
    // Also trim if the end would exceed the buffer
    if (dstStart + copyLen > TOTAL_CLIP_SAMPLES) {
      copyLen = TOTAL_CLIP_SAMPLES - dstStart;
      if (copyLen <= 0) continue;
    }
    // Copy and mix
    let p = srcStart;
    for (let i = 0; i < copyLen; i++) {
      if (p >= buf.length) p = 0;
      const dstIdx = dstStart + i;
      const sum = total[dstIdx] + buf[p];
      total[dstIdx] = sum > 32767 ? 32767 : (sum < -32768 ? -32768 : sum);
      p++;
    }
  }
  return total;
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
    const mixed = getLast30sMix(memberIds);
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
      writer.write(Buffer.from(mixed.buffer));
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


// --- Utility: Find the most populated voice channel (excluding users joined <1s ago) ---
function getMostPopulatedVoiceChannel(guild) {
  let maxMembers = 0;
  let targetChannel = null;
  const now = Date.now();
  guild.channels.cache.forEach(channel => {
    if (channel.type === 2) { // 2 = GUILD_VOICE
      let count = 0;
      for (const [userId, member] of channel.members) {
        const joinMap = userJoinTimestamps[guild.id] || {};
        if (joinMap[userId] && now - joinMap[userId] > 1000) {
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
function joinAndMonitor(channel) {
  currentChannelId = channel.id;
  updateWebMembers(channel);
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator
  });

  // Clear previous interval if any
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }

  // Track which user streams are already being handled
  const activeStreams = new Set();
  monitorInterval = setInterval(() => {
    for (const [userId, member] of channel.members) {
      if (!activeStreams.has(userId)) {
        activeStreams.add(userId);
        const opusStream = connection.receiver.subscribe(userId, {
          end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: 1000
          }
        });
  // The Discord audio is actually 128kHz stereo, but Discord.js/Opus gives us 48kHz stereo.
  // We'll send as-is, but update the server to expect 48kHz if needed, or upsample here if required.
  const decoder = new OpusEncoder(48000, 2); // 48kHz, stereo
        const userName = member.user.username;
        opusStream.on('data', (chunk) => {
          try {
            const pcm = decoder.decode(chunk);
            // Send PCM as base64 to browser
            io.emit('audio', {
              userId,
              data: Buffer.from(pcm).toString('base64')
            });
            // --- New: Accumulate PCM, downsample to 16kHz mono, send as soon as enough is buffered ---
            if (!member.whisperPcmBuffer) member.whisperPcmBuffer = [];
            // Convert to Int16Array
            const pcm16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
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
                axios.post('http://localhost:5005/transcribe', audioBuffer, {
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
                    // Voice command: "terry clip that" (robust to punctuation/spacing)
                    if (/\bterry[\s,]*clip that\b[.!?\s]*/i.test(transcriptText)) {
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
                  axios.post('http://localhost:5005/transcribe', audioBuffer, {
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
                      if (/\bterry[\s,]*clip that\b[.!?\s]*/i.test(transcriptText)) {
                        handleVoiceClipCommand(userName, userId);
                      }
                    
                    }
                  }).catch(() => {}));
              }
              member.lastWhisperSend = Date.now();
            }
          } catch (e) {
            // Ignore decode errors
          }
        });

        opusStream.on('end', () => {
          activeStreams.delete(userId);
        });
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
  // Only join if not already in a channel and eligible users are present
  if (channel && channel.id !== currentChannelId && channel.members && channel.members.size > 0) {
    // Exclude bot from count
    const botId = client.user.id;
    const realMembers = Array.from(channel.members.values()).filter(m => m.id !== botId);
    if (realMembers.length > 0) {
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
