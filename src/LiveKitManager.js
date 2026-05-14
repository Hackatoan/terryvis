/**
 * LiveKitManager — joins Element Call rooms via LiveKit and records per-user audio.
 *
 * Element Call derives the LiveKit room name from the Matrix room ID:
 *   livekit_room = "!" + matrix_room_id_localpart
 * The bot connects as a hidden participant, subscribes to all audio tracks,
 * and feeds decoded PCM into the ring buffers in RoomManager.
 *
 * Requirements: @livekit/rtc-node (native bindings), livekit-server-sdk
 */

let Room, RoomEvent, TrackKind, AudioStream;
let AccessToken;

try {
  ({ Room, RoomEvent, TrackKind, AudioStream } = require('@livekit/rtc-node'));
  ({ AccessToken } = require('livekit-server-sdk'));
} catch (e) {
  console.warn('[livekit] Native SDK not available — voice recording disabled. Install @livekit/rtc-node to enable.');
}

const LIVEKIT_URL    = process.env.LIVEKIT_URL    || 'ws://localhost:7880';
const LIVEKIT_KEY    = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_SECRET = process.env.LIVEKIT_SECRET  || 'secret';

class LiveKitManager {
  constructor(roomManager) {
    this.roomManager = roomManager;
    // matrixRoomId → LiveKit Room instance
    this.connections = new Map();
  }

  _livekitRoomName(matrixRoomId) {
    // Element Call convention: strip the ! prefix and the :server suffix
    return matrixRoomId.replace(/^!/, '').split(':')[0];
  }

  _makeToken(roomName, botIdentity) {
    if (!AccessToken) return null;
    const token = new AccessToken(LIVEKIT_KEY, LIVEKIT_SECRET, { identity: botIdentity });
    token.addGrant({ roomJoin: true, room: roomName, canPublish: false, canSubscribe: true, hidden: true });
    return token.toJwt();
  }

  async joinRoom(matrixRoomId) {
    if (!Room) {
      console.warn('[livekit] SDK not loaded, cannot join room');
      return;
    }
    if (this.connections.has(matrixRoomId)) return;

    const roomName  = this._livekitRoomName(matrixRoomId);
    const identity  = `terryvis-bot-${Date.now()}`;
    const token     = this._makeToken(roomName, identity);
    if (!token) return;

    const room = new Room();
    this.connections.set(matrixRoomId, room);

    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      const userId = participant.identity;
      console.log(`[livekit][${matrixRoomId}] subscribed to audio from ${userId}`);

      const stream = new AudioStream(track, 48000, 2);
      stream.on('frameReceived', ({ frame }) => {
        // frame.data is Int16Array of interleaved stereo 48kHz PCM
        this.roomManager.writeToUserRing(matrixRoomId, userId, frame.data);
      });
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      const state = this.roomManager.getRoomState(matrixRoomId);
      if (state) {
        const realMembers = Array.from(room.remoteParticipants.values())
          .filter(p => !p.identity.startsWith('terryvis-bot'));
        if (realMembers.length === 0) {
          console.log(`[livekit][${matrixRoomId}] no participants left, leaving`);
          this.leaveRoom(matrixRoomId);
        }
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      console.log(`[livekit][${matrixRoomId}] disconnected`);
      this.connections.delete(matrixRoomId);
    });

    try {
      await room.connect(LIVEKIT_URL, token, { autoSubscribe: true });
      console.log(`[livekit] Joined room ${roomName} for Matrix room ${matrixRoomId}`);
    } catch (e) {
      console.error(`[livekit] Failed to join ${roomName}:`, e.message);
      this.connections.delete(matrixRoomId);
    }
  }

  async leaveRoom(matrixRoomId) {
    const room = this.connections.get(matrixRoomId);
    if (!room) return;
    try { await room.disconnect(); } catch (_) {}
    this.connections.delete(matrixRoomId);
  }

  isInRoom(matrixRoomId) {
    return this.connections.has(matrixRoomId);
  }

  getParticipants(matrixRoomId) {
    const room = this.connections.get(matrixRoomId);
    if (!room) return [];
    return Array.from(room.remoteParticipants.values())
      .filter(p => !p.identity.startsWith('terryvis-bot'))
      .map(p => p.identity);
  }
}

module.exports = LiveKitManager;
