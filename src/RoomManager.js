/**
 * RoomManager — Matrix equivalent of GuildManager.
 * Manages per-room state: ring buffers, clip creation, config, call detection.
 */

const fs   = require('fs');
const path = require('path');
const wav  = require('wav');
const AsrClient = require('./AsrClient');

const CLIP_SECONDS      = 30;
const CLIP_SAMPLE_RATE  = 48000;
const CLIP_CHANNELS     = 2;
const TOTAL_CLIP_SAMPLES = CLIP_SAMPLE_RATE * CLIP_CHANNELS * CLIP_SECONDS;
const MIN_STABLE_MS     = 3000;
const KEEP_UPLOADS      = process.env.KEEP_UPLOADS === '1';

const DATA_DIR    = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(__dirname, '..', 'clips-config.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let config = { rooms: {}, dmPrefs: {} };
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) { console.error('[config] load error:', e); }
  if (!config.rooms)   config.rooms   = {};
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
  try { if (fs.existsSync(USER_CLIPS_FILE)) userClips = JSON.parse(fs.readFileSync(USER_CLIPS_FILE, 'utf8')); }
  catch (e) {}
}
function saveUserClips() {
  try { fs.writeFileSync(USER_CLIPS_FILE, JSON.stringify(userClips, null, 2)); }
  catch (e) {}
}
loadUserClips();

class RoomManager {
  constructor(matrixClient, webUI) {
    this.matrixClient = matrixClient;
    this.webUI = webUI;
    this.rooms = new Map();       // roomId → state
    this.livekitManager = null;   // set after construction to avoid circular dep
    this.asrClient = new AsrClient(webUI, this);
  }

  getRoomState(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        userRings:                  new Map(),
        transcriptContextByUser:    new Map(),
        lastClipTriggerByUser:      new Map(),
        transcriptHistoryByUser:    new Map(),
        currentCallRoomId:          null,
      });
    }
    return this.rooms.get(roomId);
  }

  getConfig(roomId) {
    if (!config.rooms[roomId]) { config.rooms[roomId] = {}; saveConfig(); }
    return config.rooms[roomId];
  }

  setConfig(roomId, key, value) {
    if (!config.rooms[roomId]) config.rooms[roomId] = {};
    config.rooms[roomId][key] = value;
    saveConfig();
  }

  getDmPrefs(userId)        { return config.dmPrefs[userId]; }
  setDmPrefs(userId, value) { config.dmPrefs[userId] = value; saveConfig(); }

  // Called by LiveKitManager when audio arrives
  writeToUserRing(roomId, userId, pcm16Stereo) {
    const state = this.getRoomState(roomId);
    let ring = state.userRings.get(userId);
    if (!ring) {
      ring = { buffer: new Int16Array(TOTAL_CLIP_SAMPLES), lastWriteTimeMs: 0, writePos: 0 };
      state.userRings.set(userId, ring);
    }
    const buf    = ring.buffer;
    const now    = Date.now();
    const pcmLen = pcm16Stereo.length;
    const gapMs  = ring.lastWriteTimeMs > 0 ? now - ring.lastWriteTimeMs : Infinity;

    if (gapMs > 100) {
      const endIndex  = Math.floor(now * 96) % TOTAL_CLIP_SAMPLES;
      ring.writePos   = (endIndex - pcmLen + TOTAL_CLIP_SAMPLES) % TOTAL_CLIP_SAMPLES;
      if (ring.lastWriteTimeMs > 0) {
        let gap = Math.min(Math.floor(gapMs * 96), TOTAL_CLIP_SAMPLES);
        let s   = Math.floor(ring.lastWriteTimeMs * 96) % TOTAL_CLIP_SAMPLES;
        for (let i = 0; i < gap; i++) buf[(s + i) % TOTAL_CLIP_SAMPLES] = 0;
      }
    }

    for (let i = 0; i < pcmLen; i++) {
      buf[ring.writePos] = pcm16Stereo[i];
      ring.writePos = (ring.writePos + 1) % TOTAL_CLIP_SAMPLES;
    }
    ring.lastWriteTimeMs = gapMs > 100 ? now : ring.lastWriteTimeMs + pcmLen / 96;

    // Voice trigger detection — feed to ASR
    this.asrClient.handleAudioFrame(roomId, userId, pcm16Stereo);
  }

  getLast30sMix(roomId, userIds) {
    const state  = this.getRoomState(roomId);
    const result = new Float32Array(TOTAL_CLIP_SAMPLES);
    const now    = Date.now();
    const cutoff = now - CLIP_SECONDS * 1000;
    const endIdx = Math.floor(now * 96) % TOTAL_CLIP_SAMPLES;

    for (const uid of userIds) {
      const ring = state.userRings.get(uid);
      if (!ring || ring.lastWriteTimeMs < cutoff) continue;
      for (let i = 0; i < TOTAL_CLIP_SAMPLES; i++) {
        result[i] += ring.buffer[(endIdx - TOTAL_CLIP_SAMPLES + i + TOTAL_CLIP_SAMPLES) % TOTAL_CLIP_SAMPLES];
      }
    }

    const out = new Int16Array(TOTAL_CLIP_SAMPLES);
    for (let i = 0; i < TOTAL_CLIP_SAMPLES; i++) {
      out[i] = Math.max(-32768, Math.min(32767, result[i]));
    }
    return out;
  }

  shouldTriggerClipFromContext(roomId, userId) {
    const state = this.getRoomState(roomId);
    const now   = Date.now();
    const last  = state.lastClipTriggerByUser.get(userId) || 0;
    if (now - last < 15000) return false;
    const hist = state.transcriptHistoryByUser.get(userId) || [];
    const ctx  = hist.join(' ').toLowerCase();
    if (!ctx) return false;
    if (ctx.includes('terry clip that')) {
      state.lastClipTriggerByUser.set(userId, now);
      state.transcriptHistoryByUser.set(userId, []);
      return true;
    }
    return false;
  }

  addUserClip(userId, title, url, roomId) {
    if (!userClips[userId]) userClips[userId] = [];
    userClips[userId].push({ url, timestamp: Date.now(), title: title || '' });
    saveUserClips();
    this.webUI.emitToAll('user_clips_updated', { roomId, userId, clips: userClips[userId] });
  }

  getUserClips(userId) { return userClips[userId] || []; }

  async handleClipCommand(roomId, requestedBy, requestedById, title, targetUserId, triggerRoomId, matrixClient) {
    try {
      const state        = this.getRoomState(roomId);
      const now          = Date.now();
      const cutoff       = now - CLIP_SECONDS * 1000;
      const botId        = matrixClient.getUserId();
      const rcfg         = this.getConfig(roomId);

      const memberIds = Array.from(state.userRings.entries())
        .filter(([uid, ring]) => ring && ring.lastWriteTimeMs > cutoff && uid !== botId)
        .map(([uid]) => uid);

      if (!memberIds.length) {
        await this._sendNotice(matrixClient, triggerRoomId, '⚠️ No audio in the last 30 seconds to clip.');
        return;
      }

      const mixed    = this.getLast30sMix(roomId, memberIds);
      const clipsDir = path.join(__dirname, '..', 'public', 'clips');
      if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

      const filename = `clip-${Date.now()}.wav`;
      const filepath = path.join(clipsDir, filename);
      const writer   = new wav.FileWriter(filepath, { channels: 2, sampleRate: 48000, bitDepth: 16 });
      writer.write(Buffer.from(mixed.buffer));
      writer.end();

      writer.on('done', async () => {
        const fileUrl    = `${process.env.CLIPS_BASE_URL || 'http://localhost:3000'}/clips/${filename}`;
        const titleText  = title ? ` — ${title}` : '';
        const actualTarget = targetUserId || requestedById;
        const dmPrefs    = this.getDmPrefs(actualTarget);

        let postedUrl = fileUrl;

        if (dmPrefs) {
          // Send as DM (Matrix 1:1 room)
          try {
            const dmRoomId = await this._getOrCreateDM(matrixClient, actualTarget);
            await matrixClient.sendMessage(dmRoomId, {
              msgtype: 'm.text',
              body: `🎥 Voice clip requested by ${requestedBy}${titleText}\n${fileUrl}`,
            });
          } catch (e) { console.error('[clip] DM failed:', e.message); }
        } else {
          const destRoomId = rcfg.clipRoomId || triggerRoomId;
          try {
            await matrixClient.sendMessage(destRoomId, {
              msgtype: 'm.text',
              body: `🎬 ${requestedBy} clipped the last 30s!${titleText}\n${fileUrl}`,
            });
          } catch (e) { console.error('[clip] post failed:', e.message); }
        }

        this.addUserClip(actualTarget, title, postedUrl, roomId);
        this.webUI.emitToAll('clip_posted', { roomId, url: postedUrl, filename, requestedBy, title });

        if (!KEEP_UPLOADS) setTimeout(() => { try { fs.unlinkSync(filepath); } catch (_) {} }, 5000);
      });
    } catch (e) {
      console.error('[clip] error:', e);
    }
  }

  async _sendNotice(matrixClient, roomId, body) {
    try {
      await matrixClient.sendMessage(roomId, { msgtype: 'm.notice', body });
    } catch (e) {}
  }

  async _getOrCreateDM(matrixClient, userId) {
    // Check existing direct rooms
    const dmMap = matrixClient.getAccountData('m.direct');
    if (dmMap) {
      const content = dmMap.getContent();
      if (content[userId] && content[userId].length) return content[userId][0];
    }
    // Create new DM room
    const resp = await matrixClient.createRoom({ is_direct: true, invite: [userId] });
    return resp.room_id;
  }
}

module.exports = RoomManager;
