# TerryVis

A Discord voice bot that streams audio to a web UI, transcribes speech using `faster-whisper`, and creates 30s clips via command or voice triggers.

## Features
- Joins the most active voice channel and streams audio to the browser
- Per-user 30s ring buffers and time-aligned mixing for clean clips
- Supports multiple Discord servers simultaneously
- Commands:
  - `-help` | `-commands`
  - `-clip`
  - `-dmtoggle`
  - `-setclip <channel_id|#mention>` (server owner only)
- Voice trigger: say exactly "terry clip that" to create a clip (detection is strict).
- Clips posted to DM if toggled, or to configured clip channel; files are deleted after posting

## Requirements
- Node.js 18+
- Python 3.9+ (For the ASR Server)
- Docker (Optional, but recommended)

## Setup with Docker (Recommended)

1. Clone the repo
```bash
git clone https://github.com/Hackatoan/terryvis.git
cd terryvis
```

2. Create your `.env`
Copy `.env.example` to `.env` and fill in at least `DISCORD_TOKEN`.

3. Start with Compose:
```bash
docker compose up --build
```

Services:
- asr: Python `faster-whisper` ASR server on port 5005
- bot: Node bot + web UI on port 3000

The web UI runs on `http://localhost:3000` by default.

## Manual Setup

1. Install Node deps
```bash
npm install
```

2. Python deps
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

3. Start the ASR server
```bash
python whisper_server.py
```

4. Start the bot + web UI
```bash
node src/index.js
```
