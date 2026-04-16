const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

class WebUI {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new Server(this.server);
    this.setupExpress();
    this.setupSocketIO();
  }

  setupExpress() {
    this.app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      next();
    });
    this.app.use(express.static(path.join(__dirname, '..', 'public')));
  }

  setupSocketIO() {
    this.io.on('connection', (socket) => {
      console.log('[web] client connected');

      socket.on('set_clip_channel', (payload) => {
        if (this.onSetClipChannel) {
          this.onSetClipChannel(payload, socket);
        }
      });

      socket.on('play_upload', (payload) => {
        if (this.onPlayUpload) {
          this.onPlayUpload(payload, socket);
        }
      });
    });
  }

  start() {
    this.server.listen(PORT, () => {
      console.log(`Web server running on http://localhost:${PORT}`);
    });
  }

  updateWebMembers(channel, guildId) {
    let textChannels = [];
    let clipChannelId = null;
    if (this.guildManager && channel) {
        textChannels = Array.from(channel.guild.channels.cache.values())
            .filter(c => c.type === 0)
            .map(c => ({ id: c.id, name: c.name }));
        const config = this.guildManager.getConfig(channel.guild.id);
        clipChannelId = config.clipChannelId || null;
    }

    let currentMembers = [];
    let channelObj = null;
    if (channel) {
      currentMembers = Array.from(channel.members.values()).map(m => ({
        id: m.id,
        username: m.user.username,
        bot: m.user.bot,
        avatar: m.user.displayAvatarURL({ format: 'png', size: 64 })
      }));
      channelObj = { id: channel.id, name: channel.name, guildId: channel.guild.id };
    }
    // We emit guild-specific updates. Clients can filter based on guildId if needed.
    this.io.emit('update', {
      channel: channelObj,
      members: currentMembers,
      textChannels,
      clipChannelId
    });
  }

  emitToAll(event, data) {
    this.io.emit(event, data);
  }
}

module.exports = WebUI;
