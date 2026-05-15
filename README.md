[![Buy Me A Coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://buymeacoffee.com/hackatoa)

# TerryVis

A Discord voice bot that streams audio to a web UI, transcribes speech using `faster-whisper`, and creates 30-second clips on command or voice trigger.

## Features

- Joins the most active voice channel and streams live audio to a browser UI
- Per-user 30s ring buffers with time-aligned mixing for clean clip captures
- Supports multiple Discord servers simultaneously
- Voice trigger: say "terry clip that" to create a clip
- Clips posted to DM or a configured clip channel; files deleted after posting

## Commands

| Command | Description |
|---|---|
| `-clip` | Save the last 30 seconds as a clip |
| `-dmtoggle` | Toggle whether clips are sent via DM |
| `-setclip <channel>` | Set the clip output channel (server owner only) |
| `-help` / `-commands` | Show all commands |

## Requirements

- Node.js 18+
- Python 3.9+ (for the ASR server)
- Docker (recommended)

## Setup with Docker

```bash
git clone https://github.com/Hackatoan/terryvis.git
cd terryvis
cp .env.example .env   # fill in DISCORD_TOKEN at minimum
docker compose up --build
```

- ASR server runs on port 5005
- Bot + web UI on port 3000 — open `http://localhost:3000`

## Manual setup

```bash
npm install
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# Terminal 1:
python whisper_server.py
# Terminal 2:
node src/index.js
```

---

[hackatoa.com](https://hackatoa.com) · [GitHub](https://github.com/Hackatoan) · [Buy Me A Coffee](https://buymeacoffee.com/hackatoa)
