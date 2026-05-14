/**
 * MatrixCommandManager — handles text commands in Matrix rooms.
 * Command prefix: - (dash), same as Discord version.
 *
 * Commands:
 *   -help / -commands
 *   -clip [title] / -clip @user:server [title]
 *   -clipfolder @user:server
 *   -dmtoggle
 *   -setclip #room:server  (room owner only)
 */

class MatrixCommandManager {
  constructor(roomManager) {
    this.roomManager = roomManager;
  }

  async handleMessage(event, room, matrixClient) {
    try {
      const content = event.getContent();
      if (!content || content.msgtype !== 'm.text') return;

      const raw     = (content.body || '').trim();
      const lower   = raw.toLowerCase();
      const sender  = event.getSender();
      const roomId  = room.roomId;

      if (lower === '-help' || lower === '-commands') {
        await matrixClient.sendMessage(roomId, {
          msgtype: 'm.notice',
          body: [
            'TerryVis Commands',
            '-clip [title]              — clip the last 30s of voice audio',
            '-clip @user:server [title] — clip for a specific user',
            '-clipfolder @user:server   — list saved clip links for a user',
            '-dmtoggle                  — toggle DM delivery of clips',
            '-setclip #room:server      — set the room clips are posted to (admin only)',
            '',
            'Voice trigger: say "terry clip that" in a call',
          ].join('\n'),
        });
        return;
      }

      if (lower === '-clip' || lower.startsWith('-clip ')) {
        const parts = raw.split(/\s+/);
        let title        = '';
        let targetUserId = null;

        // Check if second token looks like a Matrix user ID
        if (parts[1] && parts[1].startsWith('@') && parts[1].includes(':')) {
          targetUserId = parts[1];
          title        = parts.slice(2).join(' ');
        } else {
          title = parts.slice(1).join(' ');
        }

        // Find which LiveKit room to pull audio from
        const state     = this.roomManager.getRoomState(roomId);
        const callRoomId = state.currentCallRoomId || roomId;

        await this.roomManager.handleClipCommand(
          callRoomId, sender, sender, title, targetUserId, roomId, matrixClient
        );
        try { await matrixClient.sendEvent(roomId, 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: event.getId(), key: '🎬' } }); } catch (_) {}
        return;
      }

      if (lower.startsWith('-clipfolder')) {
        const parts = raw.split(/\s+/);
        const uid   = parts[1] || sender;
        const clips = this.roomManager.getUserClips(uid);
        if (!clips.length) {
          await matrixClient.sendMessage(roomId, { msgtype: 'm.notice', body: `No clips for ${uid}.` });
          return;
        }
        const list = clips.slice(-50).reverse().map(c => `${c.url}${c.title ? ' — ' + c.title : ''}`).join('\n');
        await matrixClient.sendMessage(roomId, { msgtype: 'm.notice', body: `Clips for ${uid}:\n${list}` });
        return;
      }

      if (lower === '-dmtoggle') {
        const cur = this.roomManager.getDmPrefs(sender);
        this.roomManager.setDmPrefs(sender, !cur);
        await matrixClient.sendMessage(roomId, {
          msgtype: 'm.notice',
          body: `DM clips: ${!cur ? 'ON' : 'OFF'}`,
        });
        return;
      }

      if (lower.startsWith('-setclip')) {
        // Check admin (power level ≥ 50)
        const member = room.getMember(sender);
        const power  = member ? room.getPowerLevel(sender) : 0;
        if (power < 50) {
          await matrixClient.sendMessage(roomId, { msgtype: 'm.notice', body: 'You need moderator level to use this.' });
          return;
        }
        const arg = raw.split(/\s+/)[1] || '';
        // Resolve alias like #room:server or use room ID directly
        let targetRoomId = arg;
        if (arg.startsWith('#')) {
          try {
            const resolved = await matrixClient.getRoomIdForAlias(arg);
            targetRoomId   = resolved.room_id;
          } catch (e) {
            await matrixClient.sendMessage(roomId, { msgtype: 'm.notice', body: `Could not resolve alias: ${arg}` });
            return;
          }
        }
        this.roomManager.setConfig(roomId, 'clipRoomId', targetRoomId);
        await matrixClient.sendMessage(roomId, { msgtype: 'm.notice', body: `Clip room set to ${targetRoomId}` });
        return;
      }
    } catch (e) {
      console.error('[commands] error:', e.message);
    }
  }
}

module.exports = MatrixCommandManager;
