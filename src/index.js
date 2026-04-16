require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');
const WebUI = require('./WebUI');
const GuildManager = require('./GuildManager');
const CommandManager = require('./CommandManager');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const webUI = new WebUI();
const guildManager = new GuildManager(client, webUI);
webUI.guildManager = guildManager;
const commandManager = new CommandManager(client, guildManager, webUI);

webUI.onSetClipChannel = (payload, socket) => {
  if (payload.guildId && payload.channelId !== undefined) {
    guildManager.setConfig(payload.guildId, 'clipChannelId', payload.channelId || null);
    console.log(`[web] clip channel for ${payload.guildId} set to ${payload.channelId}`);
    // broadcast update
    const g = guildManager.guilds.get(payload.guildId);
    if (g && g.channel) {
      webUI.updateWebMembers(g.channel, payload.guildId);
    }
  }
};

webUI.onPlayUpload = (payload, socket) => {
  if (!payload.guildId || !payload.data) {
    socket.emit('play_error', 'Invalid play request');
    return;
  }
  try {
    const upDir = path.join(__dirname, '..', 'public', 'uploads');
    if (!fs.existsSync(upDir)) fs.mkdirSync(upDir, { recursive: true });

    const ext = (payload.name && payload.name.includes('.')) ? payload.name.split('.').pop() : 'bin';
    const filename = `upload-${Date.now()}.${ext}`;
    const filepath = path.join(upDir, filename);

    // Write array buffer to file
    const buf = Buffer.from(payload.data);
    fs.writeFileSync(filepath, buf);

    const url = `/uploads/${filename}`;
    socket.emit('play_saved', { url, name: payload.name || filename });

    socket.emit('play_started');
    guildManager.playFileFromDisk(payload.guildId, filepath,
      () => { console.log(`[web] playing file ${filename} in guild ${payload.guildId}`); },
      () => { socket.emit('play_ended'); },
      (err) => { socket.emit('play_error', err.message); }
    );
  } catch (e) {
    console.error('Error handling upload:', e);
    socket.emit('play_error', 'Upload handling failed');
  }
};

client.on('ready', () => {
  console.log(`[discord] Logged in as ${client.user.tag}`);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  guildManager.handleVoiceStateUpdate(oldState, newState);
});

client.on('messageCreate', async (message) => {
  commandManager.handleMessage(message);
});

setInterval(() => {
  guildManager.checkEligibleChannels();
}, 2000);

webUI.start();

if (DISCORD_TOKEN) {
    client.login(DISCORD_TOKEN);
} else {
    console.warn("DISCORD_TOKEN is not set. Bot will not connect to Discord.");
}
