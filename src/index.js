require('dotenv').config();
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
const commandManager = new CommandManager(client, guildManager, webUI);

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
