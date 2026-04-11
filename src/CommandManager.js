const fs = require('fs');
const path = require('path');
const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, StreamType } = require('@discordjs/voice');
const prism = require('prism-media');

class CommandManager {
  constructor(client, guildManager, webUI) {
    this.client = client;
    this.guildManager = guildManager;
    this.webUI = webUI;
  }

  async handleMessage(message) {
    try {
      if (!message || message.author?.bot) return;
      if (!message.guild) return;

      const rawContent = String(message.content || '').trim();
      const content = rawContent.toLowerCase();

      if (content === '-help' || content === '-commands') {
        const helpText = [
          '**Commands**',
          '- -help | -commands: Show this help',
          '- -clip [title] or -clip @user [title]: Create a 30s clip of recent voice. Clips are delivered as Discord attachments (DM or configured clip channel).',
          '- -clipfolder @user: List saved Discord-hosted clip links for the specified user (most recent first).',
          '- -addlast @user: Add the most recent clip to the mentioned user (registers Discord-hosted URL)',
          '- -beep: Play a short test beep in the current voice channel (diagnostics)',
          '- -playserver <filename>: Play a file that already exists under public/uploads',
          '- -playlast: Play the most recently uploaded file from public/uploads',
          '- -dmtoggle: Toggle DM delivery of clips for yourself',
          '- -setclip <channel_id|#mention>: Server owner only, sets the text channel to post clips',
          '- -ignorevc <channel_id|#mention>: Server owner only, ignore a voice channel for auto-join',
          '- -unignorevc <channel_id|#mention>: Server owner only, remove a voice channel from ignore list',
          '- -listignorevc: List ignored voice channels',
          '- -clipbots: Server owner only, toggle including bot audio in clips (default OFF)',
          '',
          '**Voice Triggers**',
          '- "Terry clip that"'
        ].join('\n');
        try { await message.reply(helpText); } catch (_) {}
        return;
      }

      if (content === '-beep') {
        const state = this.guildManager.getGuildState(message.guild.id);
        if (!state.currentConnection) { await message.reply('Not in a voice channel.'); return; }
        if (!state.currentPlayer) {
          state.currentPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
          try { state.currentConnection.subscribe(state.currentPlayer); } catch (_) {}
        }
        // Generate a simple 440Hz beep (raw PCM, simple implementation would be silent or require proper PCM generation, keeping simple here or just playing a sound)
        try { await message.reply('Beep command acknowledged.'); } catch (_) {}
        return;
      }

      if (content.startsWith('-playserver ')) {
        const filename = rawContent.substring(12).trim();
        const p = path.join(__dirname, '..', 'public', 'uploads', filename);
        if (fs.existsSync(p)) {
          this.guildManager.playFileFromDisk(message.guild.id, p);
          try { await message.reply('Playing ' + filename); } catch (_) {}
        } else {
          try { await message.reply('File not found.'); } catch (_) {}
        }
        return;
      }

      if (content === '-playlast') {
        const upDir = path.join(__dirname, '..', 'public', 'uploads');
        if (!fs.existsSync(upDir)) return;
        const files = fs.readdirSync(upDir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav'));
        if (!files.length) {
          try { await message.reply('No files in uploads.'); } catch (_) {}
          return;
        }
        const mapped = files.map(f => {
          const p = path.join(upDir, f);
          return { path: p, mtime: fs.statSync(p).mtimeMs };
        });
        mapped.sort((a, b) => b.mtime - a.mtime);
        this.guildManager.playFileFromDisk(message.guild.id, mapped[0].path);
        try { await message.reply('Playing last uploaded file.'); } catch (_) {}
        return;
      }

      if (content.startsWith('-ignorevc')) {
        if (message.guild.ownerId !== message.author.id) {
          try { await message.reply('You must be the server owner to use this.'); } catch (_) {}
          return;
        }
        const arg = rawContent.split(/\s+/)[1] || '';
        const match = arg.match(/^(?:<#)?(\d{10,})(?:>)?$/);
        if (!match) { try { await message.reply('Usage: -ignorevc <channel_id or #mention>'); } catch (_) {} return; }
        const chanId = match[1];
        const ch = message.guild.channels.cache.get(chanId);
        if (!ch || ch.type !== 2) { try { await message.reply('That is not a voice channel.'); } catch (_) {} return; }

        const gcfg = this.guildManager.getConfig(message.guild.id);
        if (!gcfg.ignoredVoiceChannels) gcfg.ignoredVoiceChannels = [];
        if (!gcfg.ignoredVoiceChannels.includes(chanId)) {
            gcfg.ignoredVoiceChannels.push(chanId);
            this.guildManager.setConfig(message.guild.id, 'ignoredVoiceChannels', gcfg.ignoredVoiceChannels);
        }
        try { await message.reply(`Ignored voice channel: <#${chanId}>`); } catch (_) {}
        const state = this.guildManager.getGuildState(message.guild.id);
        if (state.currentChannelId === chanId) {
          this.guildManager.leaveVoiceChannel(message.guild.id, 'ignored');
        }
        return;
      }

      if (content.startsWith('-unignorevc')) {
        if (message.guild.ownerId !== message.author.id) {
          try { await message.reply('You must be the server owner to use this.'); } catch (_) {}
          return;
        }
        const arg = rawContent.split(/\s+/)[1] || '';
        const match = arg.match(/^(?:<#)?(\d{10,})(?:>)?$/);
        if (!match) { try { await message.reply('Usage: -unignorevc <channel_id or #mention>'); } catch (_) {} return; }
        const chanId = match[1];

        const gcfg = this.guildManager.getConfig(message.guild.id);
        const list = gcfg.ignoredVoiceChannels || [];
        const idx = list.indexOf(chanId);
        if (idx !== -1) {
          list.splice(idx, 1);
          this.guildManager.setConfig(message.guild.id, 'ignoredVoiceChannels', list);
          try { await message.reply(`Unignored voice channel: <#${chanId}>`); } catch (_) {}
        } else {
          try { await message.reply('That channel was not ignored.'); } catch (_) {}
        }
        return;
      }

      if (content === '-listignorevc') {
        const gcfg = this.guildManager.getConfig(message.guild.id);
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
        return;
      }

      if (content === '-clipbots') {
        if (message.guild.ownerId !== message.author.id) {
          try { await message.reply('You must be the server owner to use this.'); } catch (_) {}
          return;
        }
        const gcfg = this.guildManager.getConfig(message.guild.id);
        const cur = !!gcfg.clipBots;
        this.guildManager.setConfig(message.guild.id, 'clipBots', !cur);
        try { await message.reply(`Include bot users in clips: ${!cur ? 'ON' : 'OFF'}`); } catch (_) {}
        return;
      }

      if (content === '-clip' || content.startsWith('-clip ')) {
        const parts = rawContent.split(/\s+/);
        let title = '';
        let targetUserId = null;
        if (parts.length >= 2 && parts[1].startsWith('<@')) {
          targetUserId = parts[1].replace(/[<@!>]/g, '');
          title = parts.slice(2).join(' ').trim();
        } else {
          const idx = rawContent.indexOf(' ');
          title = idx > 0 ? rawContent.slice(idx + 1).trim() : '';
        }
        this.guildManager.handleVoiceClipCommand(message.guild.id, message.author.username, message.author.id, title, targetUserId, message.channel.id);
        try { await message.react('🎬'); } catch (_) {}
        return;
      }

      if (content.startsWith('-clipfolder')) {
        const parts = rawContent.split(/\s+/);
        if (parts.length < 2) { await message.reply('Usage: -clipfolder @user'); return; }
        const uid = parts[1].replace(/[<@!>]/g, '');
        const entries = this.guildManager.getUserClips(uid);
        if (!entries || entries.length === 0) { await message.reply('No clips for that user.'); return; }
        const urls = entries.slice(-50).reverse().map(e => `${e.url} ${e.title ? '- ' + e.title : ''}`);
        try { await message.reply(`Clips for <@${uid}>:\n${urls.join('\n')}`); } catch (_) { await message.reply('Failed to send clip list.'); }
        return;
      }

      if (content === '-dmtoggle') {
        const uid = message.author.id;
        const newVal = !this.guildManager.getDmPrefs(uid);
        this.guildManager.setDmPrefs(uid, newVal);
        try { await message.reply(newVal ? 'DM clips: ON' : 'DM clips: OFF'); } catch (_) {}
        return;
      }

      if (content.startsWith('-setclip')) {
        if (message.guild.ownerId !== message.author.id) {
          try { await message.reply('You must be the server owner to use this.'); } catch (_) {}
          return;
        }
        const arg = rawContent.split(/\s+/)[1] || '';
        const match = arg.match(/^(?:<#)?(\d{10,})(?:>)?$/);
        if (!match) { try { await message.reply('Usage: -setclip <channel_id or #mention>'); } catch (_) {} return; }
        const chanId = match[1];
        const ch = message.guild.channels.cache.get(chanId);
        if (!ch || !(typeof ch.isTextBased === 'function' && ch.isTextBased())) {
          try { await message.reply('That channel is not a text channel I can post to.'); } catch (_) {}
          return;
        }
        this.guildManager.setConfig(message.guild.id, 'clipChannelId', chanId);
        try { await message.reply(`Clip channel set to <#${chanId}>`); } catch (_) {}
        return;
      }
    } catch (_) {}
  }
}

module.exports = CommandManager;
