1. **Fix audio playback**: Modify `playFileFromDisk` in `src/GuildManager.js` to use `@discordjs/voice`'s `createAudioResource(filePath)` directly instead of piping `ffmpeg` into `prism.opus.Encoder`. This handles framing properly and works.
2. **Add "Forward stream"**:
    - Update `public/index.html` to add a "Stream URL" input field and a "Stop" button.
    - Update `public/audio.js` to send `streamUrl` in `play_upload` payload and handle the "Stop" button via a new `stop_play` socket event.
    - Update `src/WebUI.js` and `src/index.js` to handle `streamUrl` and `stop_play`.
3. **Volume boost per user from webpanel**:
    - Add a global `window.userVolumes = {};` in `public/audio.js`.
    - In `socket.on('update')`, render a `<input type="range">` volume slider next to each member.
    - Apply this volume multiplier in the `scriptNode.onaudioprocess` loop.
4. **Set server clip channel from webpanel**:
    - Pass `guildManager` to `webUI` so `updateWebMembers` can fetch text channels and current config.
    - Emit `textChannels` and `clipChannelId` via `socket.io` in `WebUI.js`.
    - Update `public/index.html` to include a dropdown and save button for the clip channel in the guild template.
    - Update `public/audio.js` to populate this dropdown and listen to changes, emitting `set_clip_channel`.
    - Update `src/WebUI.js` and `src/index.js` to listen for `set_clip_channel` and update config using `guildManager.setConfig`.
5. **Pre-commit**: Run tests and verifications using `pre_commit_instructions`.
