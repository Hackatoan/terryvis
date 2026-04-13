const fs = require('fs');
let html = fs.readFileSync('public/index.html', 'utf8');

// Insert after file-input
const fileInputStr = '<input type="file" id="file-input" accept="audio/mp3,audio/mpeg,audio/wav" style="background:#2c2f33;color:#fff;border:1px solid #3a3f44;border-radius:6px;padding:8px;"/>';
const streamHtml = '\n      <div style="display:flex;gap:10px;"><input type="text" id="stream-url" placeholder="Or enter stream URL (e.g. Icecast/Shoutcast)" style="flex:1;background:#2c2f33;color:#fff;border:1px solid #3a3f44;border-radius:6px;padding:8px;"/><button id="stop-btn" style="padding:8px 12px;border-radius:8px;background:#d83c3e;color:#fff;border:none;cursor:pointer;">Stop</button></div>';

html = html.replace(fileInputStr, fileInputStr + streamHtml);

// Insert server clip channel setting in the template
const guildChannelStr = '<div class="channel guild-channel">Loading...</div>';
const channelSelectorStr = '\n        <div style="flex:1;margin-left:12px;display:flex;align-items:center;gap:8px;"><select class="clip-channel-select" style="background:#2c2f33;color:#fff;border:1px solid #3a3f44;border-radius:4px;padding:4px;"><option value="">Default Clip Channel</option></select><button class="save-clip-channel-btn" style="padding:4px 8px;border-radius:4px;background:#5865f2;color:#fff;border:none;cursor:pointer;font-size:0.85em;">Save</button></div>';

html = html.replace(guildChannelStr, guildChannelStr + channelSelectorStr);

fs.writeFileSync('public/index.html', html);
