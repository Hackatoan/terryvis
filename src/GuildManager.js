const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, StreamType, AudioPlayerStatus, VoiceConnectionStatus, entersState, EndBehaviorType } = require('@discordjs/voice');
const { spawn } = require('child_process');
const prism = require('prism-media');
const fs = require('fs');
const path = require('path');
const wav = require('wav');
const AsrClient = require('./AsrClient');

const CLIP_SECONDS = 30;
const CLIP_SAMPLE_RATE = 48000;
const CLIP_CHANNELS = 2;
const MIN_STABLE_MS = 3000;
const TOTAL_CLIP_SAMPLES = CLIP_SAMPLE_RATE * CLIP_CHANNELS * CLIP_SECONDS;

const KEEP_UPLOADS = process.env.KEEP_UPLOADS === '1';

// Shared config loading
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = path.join(__dirname, '..', 'clips-config.json');

let config = { guilds: {}, dmPrefs: {} };
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      config = JSON.parse(data);
    }
  } catch (e) { console.error('[config] load error:', e); }
  if (!config.guilds) config.guilds = {};
  if (!config.dmPrefs) config.dmPrefs = {};
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
  catch (e) { console.error('[config] save error:', e); }
}
loadConfig();

const USER_CLIPS_FILE = path.join(DATA_DIR, 'user-clips.json');
let userClips = {};
function loadUserClips() {
  try {
    if (fs.existsSync(USER_CLIPS_FILE)) {
      userClips = JSON.parse(fs.readFileSync(USER_CLIPS_FILE, 'utf8'));
    }
  } catch (e) { console.error('[clips] load error:', e); }
}
function saveUserClips() {
  try { fs.writeFileSync(USER_CLIPS_FILE, JSON.stringify(userClips, null, 2)); }
  catch (e) { console.error('[clips] save error:', e); }
}
loadUserClips();

class GuildManager {
  constructor(client, webUI) {
    this.client = client;
    this.webUI = webUI;
    this.guilds = new Map();
    this.asrClient = new AsrClient(this.webUI, this);

    // Legacy support logic that still relies on file-level state
    this.userJoinTimestamps = {};
  }

  getConfig(guildId) {
      if(!config.guilds[guildId]) {
          config.guilds[guildId] = {};
          saveConfig();
      }
      return config.guilds[guildId];
  }

  setConfig(guildId, key, value) {
      if(!config.guilds[guildId]) {
          config.guilds[guildId] = {};
      }
      config.guilds[guildId][key] = value;
      saveConfig();
  }

  getDmPrefs(userId) {
      return config.dmPrefs[userId];
  }

  setDmPrefs(userId, value) {
      config.dmPrefs[userId] = value;
      saveConfig();
  }

  getGuildState(guildId) {
    if (!this.guilds.has(guildId)) {
      this.guilds.set(guildId, {
        currentChannelId: null,
        currentConnection: null,
        currentPlayer: null,
        userRings: new Map(),
        activeStreams: new Map(),
        transcriptContextByUser: new Map(),
        lastClipTriggerByUser: new Map(),
        transcriptHistoryByUser: new Map()
      });
    }
    return this.guilds.get(guildId);
  }

  checkEligibleChannels() {
    this.client.guilds.cache.forEach(guild => {
      if (!this.userJoinTimestamps[guild.id]) this.userJoinTimestamps[guild.id] = {};
      const now = Date.now();
      guild.channels.cache.forEach(channel => {
        if (channel.type === 2) {
          for (const [userId, member] of channel.members) {
            if (!this.userJoinTimestamps[guild.id][userId]) {
              this.userJoinTimestamps[guild.id][userId] = now;
            }
          }
        }
      });

      const state = this.getGuildState(guild.id);
      const channel = this.getMostPopulatedVoiceChannel(guild);

      if (state.currentChannelId) {
        const curr = guild.channels.cache.get(state.currentChannelId);
        if (!curr || (curr.members && Array.from(curr.members.values()).filter(m => m.id !== this.client.user.id).length === 0)) {
          this.leaveVoiceChannel(guild.id, 'periodic-empty');
        }
      }

      if (!state.currentChannelId && channel && channel.members && channel.members.size > 0) {
        const botId = this.client.user.id;
        const now2 = Date.now();
        const realMembers = Array.from(channel.members.values()).filter(m => m.id !== botId);
        const joinMap = this.userJoinTimestamps[guild.id] || {};
        const hasStable = realMembers.some(m => joinMap[m.id] && (now2 - joinMap[m.id]) >= MIN_STABLE_MS);
        if (realMembers.length > 0 && hasStable) {
          this.joinAndMonitor(channel);
        }
      }

      if (state.currentChannelId) {
        const channel = guild.channels.cache.get(state.currentChannelId);
        if (channel) this.webUI.updateWebMembers(channel);
      }
    });
  }

  getMostPopulatedVoiceChannel(guild) {
    let maxMembers = 0;
    let targetChannel = null;
    const now = Date.now();
    const gcfg = config.guilds[guild.id] || {};
    const ignored = new Set(gcfg.ignoredVoiceChannels || []);

    guild.channels.cache.forEach(channel => {
      if (channel.type === 2) {
        if (ignored.has(channel.id)) return;
        let count = 0;
        for (const [userId, member] of channel.members) {
          const joinMap = this.userJoinTimestamps[guild.id] || {};
          if (this.client.user && userId === this.client.user.id) continue;
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

  handleVoiceStateUpdate(oldState, newState) {
    const guild = newState.guild;
    const state = this.getGuildState(guild.id);
    if (!state.currentChannelId) return;
    const channel = guild.channels.cache.get(state.currentChannelId);
    if (channel) this.webUI.updateWebMembers(channel);
  }

  joinAndMonitor(channel) {
    const guildId = channel.guild.id;
    const state = this.getGuildState(guildId);

    console.log(`[voice][${guildId}] joining channel ${channel.id} ${channel.name}`);
    state.currentChannelId = channel.id;
    this.webUI.updateWebMembers(channel);

    state.currentConnection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    try {
      state.currentConnection.on('stateChange', (oldS, newS) => {
        console.log(`[voice][${guildId}] connection stateChange: ${oldS?.status} -> ${newS?.status}`);
      });
    } catch (_) {}

    if (!state.currentPlayer) {
      state.currentPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      try {
        state.currentPlayer.on('stateChange', (o, n) => console.log(`[voice][${guildId}] player stateChange: ${o?.status} -> ${n?.status}`));
        state.currentPlayer.on('error', (e) => console.warn(`[voice][${guildId}] player error: ${e?.message || e}`));
      } catch (_) {}
    }
    try {
      state.currentConnection.subscribe(state.currentPlayer);
      console.log(`[voice][${guildId}] subscribed player to connection`);
    } catch (e) {
      console.warn(`[voice][${guildId}] subscribe error: ${e?.message}`);
    }

    entersState(state.currentConnection, VoiceConnectionStatus.Ready, 15000)
      .then(() => console.log(`[voice][${guildId}] connection Ready`))
      .catch((e) => console.warn(`[voice][${guildId}] connection not ready: ${e?.message || e}`));

    const receiver = state.currentConnection.receiver;
    receiver.speaking.on('start', (userId) => {
      this.asrClient.handleAudioStream(guildId, userId, receiver);
    });
  }

  leaveVoiceChannel(guildId, reason = '') {
    try {
      const state = this.getGuildState(guildId);
      console.log(`[voice][${guildId}] leaving voice channel ${state.currentChannelId || '(none)'} reason= ${reason}`);

      if (state.currentPlayer) {
        try { state.currentPlayer.stop(true); } catch (e) { console.warn(`[voice][${guildId}] currentPlayer.stop error:`, e?.message); }
        state.currentPlayer = null;
      }
      if (state.currentConnection) {
        try { state.currentConnection.destroy(); } catch (e) { console.warn(`[voice][${guildId}] connection.destroy error:`, e?.message); }
        state.currentConnection = null;
      }
      state.currentChannelId = null;
      state.userRings.clear();
      this.webUI.updateWebMembers(null, guildId);
    } catch (_) {}
  }

  writeToUserRing(guildId, userId, pcm16Stereo) {
    const state = this.getGuildState(guildId);
    let ring = state.userRings.get(userId);
    if (!ring) {
      ring = { buffer: new Int16Array(TOTAL_CLIP_SAMPLES), writeIndex: 0, filled: 0, lastWriteTimeMs: 0, lastEndMs: 0, chunks: [] };
      state.userRings.set(userId, ring);
    }
    const buf = ring.buffer;
    let idx = ring.writeIndex;
    for (let i = 0; i < pcm16Stereo.length; i++) {
      buf[idx] = pcm16Stereo[i];
      idx = (idx + 1) % TOTAL_CLIP_SAMPLES;
    }
    ring.writeIndex = idx;
    ring.filled = Math.min(ring.filled + pcm16Stereo.length, TOTAL_CLIP_SAMPLES);
    const now = Date.now();
    ring.lastWriteTimeMs = now;
    ring.lastEndMs = now;
    ring.chunks.push({ endMs: now, sampleCount: pcm16Stereo.length });

    // prune chunks
    const cutoff = now - (CLIP_SECONDS * 1000);
    while (ring.chunks.length > 0 && ring.chunks[0].endMs < cutoff) {
      ring.chunks.shift();
    }
  }

  getLast30sMix(guildId, userIds) {
    const state = this.getGuildState(guildId);
    const result = new Int16Array(TOTAL_CLIP_SAMPLES);
    const now = Date.now();
    const cutoff = now - (CLIP_SECONDS * 1000);

    let mixedCount = 0;
    for (const uid of userIds) {
      const ring = state.userRings.get(uid);
      if (!ring || ring.filled === 0) continue;

      let validSamples = 0;
      for (const ch of ring.chunks) {
        if (ch.endMs > cutoff) validSamples += ch.sampleCount;
      }
      if (validSamples <= 0) continue;
      validSamples = Math.min(validSamples, TOTAL_CLIP_SAMPLES);

      let readIdx = (ring.writeIndex - validSamples + TOTAL_CLIP_SAMPLES) % TOTAL_CLIP_SAMPLES;
      let offset = TOTAL_CLIP_SAMPLES - validSamples;

      for (let i = 0; i < validSamples; i++) {
        const sample = ring.buffer[(readIdx + i) % TOTAL_CLIP_SAMPLES];
        const resIdx = offset + i;
        result[resIdx] = Math.max(-32768, Math.min(32767, result[resIdx] + sample));
      }
      mixedCount++;
    }
    return result;
  }

  addUserClip(userId, title, url, guildId) {
      if (!userClips[userId]) userClips[userId] = [];
      userClips[userId].push({ url, timestamp: Date.now(), title: title || '' });
      saveUserClips();
      this.webUI.emitToAll('user_clips_updated', { guildId, userId, clips: userClips[userId] });
  }

  getUserClips(userId) {
      return userClips[userId] || [];
  }

  shouldTriggerClipFromContext(guildId, userId) {
    const state = this.getGuildState(guildId);
    const now = Date.now();
    const last = state.lastClipTriggerByUser.get(userId) || 0;

    // Cooldown
    if (now - last < 15000) return false;

    const hist = state.transcriptHistoryByUser.get(userId) || [];
    const ctx = hist.join(' ').toLowerCase();

    if (!ctx) return false;

    const canonical = 'terry clip that';
    if (ctx.includes(canonical)) {
      state.lastClipTriggerByUser.set(userId, now);
      state.transcriptHistoryByUser.set(userId, []);
      return true;
    }
    return false;
  }

  async playFileFromDisk(guildId, filePath, onStart, onEnd, onError) {
    try {
      const state = this.getGuildState(guildId);
      if (!state.currentConnection) throw new Error('No voice connection');
      await entersState(state.currentConnection, VoiceConnectionStatus.Ready, 10000);
      if (!state.currentPlayer) {
        state.currentPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
        try { state.currentConnection.subscribe(state.currentPlayer); } catch (_) {}
      }

      const resource = createAudioResource(filePath);

      const started = () => { onStart && onStart(); try { state.currentPlayer.off(AudioPlayerStatus.Playing, started); } catch (_) {} };
      const ended = () => { onEnd && onEnd(); try { state.currentPlayer.off(AudioPlayerStatus.Idle, ended); } catch (_) {} };
      try { state.currentPlayer.removeAllListeners(AudioPlayerStatus.Playing); } catch (_) {}
      try { state.currentPlayer.removeAllListeners(AudioPlayerStatus.Idle); } catch (_) {}

      state.currentPlayer.on(AudioPlayerStatus.Playing, started);
      state.currentPlayer.on(AudioPlayerStatus.Idle, ended);
      state.currentPlayer.on('error', (err) => { onError && onError(err); });

      state.currentPlayer.play(resource);
    } catch (e) {
      if (onError) onError(e);
    }
  }

  async handleVoiceClipCommand(guildId, requestedByName, requestedById, titleOptional, targetUserId, triggerChannelId) {
      try {
          const state = this.getGuildState(guildId);
          const guild = this.client.guilds.cache.get(guildId);
          if (!guild || !state.currentChannelId) return;
          const voiceChan = guild.channels.cache.get(state.currentChannelId);
          if (!voiceChan) return;

          const now = Date.now();
          const cutoff = CLIP_SECONDS * 1000;
          const botId = this.client.user?.id;
          const gcfg = config.guilds[guild.id] || {};
          const includeBots = !!gcfg.clipBots;
          const windowStart = now - cutoff;

          const memberIds = Array.from(state.userRings.entries())
            .filter(([uid, ring]) => ring && ring.chunks && ring.chunks.some(ch => ch.endMs > windowStart))
            .filter(([uid]) => uid !== botId)
            .filter(([uid]) => includeBots || !(guild.members.cache.get(uid)?.user?.bot))
            .map(([uid]) => uid);

          if (memberIds.length === 0) return;

          const mixed = this.getLast30sMix(guildId, memberIds);

          const clipsDir = path.join(__dirname, '..', 'public', 'clips');
          if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });
          const filename = `clip-${Date.now()}.wav`;
          const filepath = path.join(clipsDir, filename);

          const writer = new wav.FileWriter(filepath, { channels: 2, sampleRate: 48000, bitDepth: 16 });
          const buf = Buffer.from(mixed.buffer);
          writer.write(buf);
          writer.end();

          writer.on('done', async () => {
              const fileUrl = `${process.env.CLIPS_BASE_URL || 'http://localhost:3000'}/clips/${filename}`;
              const titleText = titleOptional ? ` - ${titleOptional}` : '';

              let postedUrl = '';

              // Target clip to a specific user?
              const actualTargetUserId = targetUserId || requestedById;
              const dmPrefs = this.getDmPrefs(actualTargetUserId);

              if (dmPrefs) {
                  try {
                      const user = await this.client.users.fetch(actualTargetUserId);
                      if (user) {
                          const msg = await user.send({
                              content: `🎥 Voice Clip requested by **${requestedByName}**${titleText}`,
                              files: [filepath]
                          });
                          if (msg.attachments.size > 0) postedUrl = msg.attachments.first().url;
                      }
                  } catch (e) { console.error('Failed to DM clip:', e); }
              } else {
                  const targetChannelId = gcfg.clipChannelId || process.env.CLIPS_CHANNEL_ID || triggerChannelId;
                  if (targetChannelId) {
                      try {
                          const destChan = guild.channels.cache.get(targetChannelId);
                          if (destChan && typeof destChan.send === 'function') {
                              const titleLine = titleOptional ? ` - ${titleOptional}` : '';
                              const msg = await destChan.send({
                                  content: `🎬 **${requestedByName}** clipped the last 30s!${titleLine}`,
                                  files: [filepath]
                              });
                              if (msg.attachments.size > 0) postedUrl = msg.attachments.first().url;
                          }
                      } catch (e) { console.error('Failed to post clip to channel:', e); }
                  }
              }

              if (postedUrl) {
                  this.addUserClip(actualTargetUserId, titleOptional, postedUrl, guildId);
                  this.webUI.emitToAll('clip_posted', { guildId, url: postedUrl, filename, requestedBy: requestedByName, title: titleOptional });
              }

              if (!KEEP_UPLOADS && fs.existsSync(filepath)) {
                  setTimeout(() => { try { fs.unlinkSync(filepath); } catch (_) {} }, 5000);
              }
          });
      } catch (e) {
          console.error('[clip] error:', e);
      }
  }

}

module.exports = GuildManager;
