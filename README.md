# TerryVis

A Discord voice bot that streams audio to a web UI, transcribes speech using a local Whisper server, and creates 30s clips via command or voice triggers.

## Features
- Joins the most active voice channel and streams audio to the browser
- Per-user 30s ring buffers and time-aligned mixing for clean clips
- Commands:
  - `-help` | `-commands`
  - `-clip`
  - `-dmtoggle`
  - `-setclip <channel_id|#mention>` (server owner only)
- Voice triggers with fuzzy recognition (e.g., "terry clip that", "okay terry clip that", "re-clip that", and common ASR miss-hears like "club that")
- Clips posted to DM if toggled, or to configured clip channel; files are deleted after posting

## Requirements
- Node.js 18+
- Python 3.9+
- (Optional) `espeak` CLI: lightweight local TTS for the `-say` command (recommended on low-resource hosts)

## Setup

1. Clone the repo

```bash
git clone https://github.com/Hackatoan/terryvis.git
cd terryvis
```

2. Install Node deps

```bash
npm install
```

3. Create your `.env`

Copy `.env.example` to `.env` and fill in at least `DISCORD_TOKEN`.
Optional variables:
- `CLIPS_CHANNEL_ID` (default target unless set via `-setclip`)
- `PORT` (web UI, default 3000)
- `WHISPER_URL` (defaults to http://127.0.0.1:5005; server also accepts `/transcribe`)
- `WHISPER_MODEL` (for the Python server; default tiny.en)

4. Python deps

It's recommended to use a virtual environment.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

5. Start the Whisper server

```bash
python whisper_server.py
```

- It will start on `http://localhost:5005` and expose `POST /transcribe`.
- The server also accepts `POST /` as an alias and supports `.env` via `python-dotenv`.
- Adjust the model with `WHISPER_MODEL` (e.g., `base.en`, `small.en`).

6. Start the bot + web UI

```bash
npm start
```

- Web UI runs on `http://localhost:3000` by default.

## Usage
- Invite your bot to the server and ensure it has permissions for voice and posting in the target text channel.
- The bot will join the most active voice channel automatically when users are present.
- Commands are available in any text channel:
  - `-help` shows all commands and voice triggers
  - `-clip` posts a 30s clip (DM if toggled, else in clip channel)
  - `-dmtoggle` toggles DM delivery for your user
  - `-setclip <channel_id|#mention>` sets the clip channel (server owner only)
  - `-say <text>`: speak short English text into the current voice channel using local `espeak`.
- Voice trigger: say variants like "Terry clip that", "Okay Terry, clip that", "re-clip that", or split phrases within a few seconds.

Trigger behavior (stricter by default)

- The bot now uses a stricter matching policy for voice triggers to reduce accidental clips:
  - Short proximity windows (≈3 words) between "terry" and "clip" are required.
  - A longer cooldown (≈7s) prevents repeat triggering from nearby words.
  - Fuzzy fallbacks have been tightened; only close variants like "click" or "clips" are considered.

- Tuning: if you want more/less sensitivity, edit `shouldTriggerClipFromContext` in `bot.js`:
  - Reduce the cooldown or increase word windows to be more permissive.
  - Or switch `ASR_ENGINE=vosk` and provide a focused grammar to improve detection (see below).

## Notes
- `public/clips/` is served statically and ignored by git. Files are deleted after posting.
- `models/` is ignored from git to avoid large binary blobs.
- The Python server enforces a small noise gate and a job timeout; see `whisper_server.py` constants.

## Troubleshooting
## Docker

Run both services with Docker:

1. Create a `.env` in the project root with at least `DISCORD_TOKEN`.
  - Optional: `CLIPS_CHANNEL_ID`, `PORT` (for web UI), `WHISPER_URL`, `WHISPER_MODEL`.
  - When using Docker Compose, `WHISPER_URL` defaults to `http://whisper:5005`.

2. Start with Compose:

```bash
docker compose up --build
```

Services:
- whisper: Python Whisper server on port 5005 (exposed)
- bot: Node bot + web UI on port 3000 (exposed)

The clips folder is mounted at `./public/clips` for persistence.

- If you see 404s on the Whisper server, ensure the bot `WHISPER_URL` points to `/transcribe` or use the root alias (`/`).
- Ensure your bot token is correct and that the bot is not blocked by server permissions.
- For better transcription quality, try `WHISPER_MODEL=base.en` (or higher) and ensure CPU resources are sufficient.

Docker notes and quick setup

- The included `docker-compose.yml` exposes environment variables for easy configuration. Create a `.env` file in the project root (it is `.gitignore`d) and set values there. Example `.env` entries:

```dotenv
DISCORD_TOKEN=your-bot-token
ASR_ENGINE=vosk       # or 'whisper'
VOSK_MODEL=./models/vosk-model-small-en-us-0.15
WHISPER_MODEL=tiny.en
CLIPS_CHANNEL_ID=
PORT=3000
```

- If you choose `ASR_ENGINE=vosk`, download the Vosk small model into `./models` and it will be mounted into the bot container at `/app/models` (compose uses the host path by default). Example model download:

```bash
mkdir -p models && cd models
wget https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip
unzip vosk-model-small-en-us-0.15.zip
cd ..
```

- Start the stack with docker compose and the services will pick up variables from `.env`:

```bash
docker compose up --build
```

- To run only the bot with Vosk pointing to a local model (no Whisper service), set `ASR_ENGINE=vosk` and ensure `VOSK_MODEL` points to a valid model path on the host. You can also remove the `whisper` service from the compose file if desired.

### Faster / lower-resource ASR (optional)

If Whisper is too slow on your host, you can switch to a lighter offline ASR engine: Vosk. Vosk has small English models that run faster on CPUs and work well for short voice commands.

- Install Vosk and a small English model:

```bash
pip install vosk
# download a small model (example):
mkdir -p models && cd models
wget https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip
unzip vosk-model-small-en-us-0.15.zip
cd ..
```

- Set environment variables before starting the Python server/bot:

```bash
export ASR_ENGINE=vosk
export VOSK_MODEL=./models/vosk-model-small-en-us-0.15
python whisper_server.py
```

This project supports `ASR_ENGINE=whisper` (default) and `ASR_ENGINE=vosk` (faster). Vosk trades some accuracy for speed but is generally more responsive for short spoken commands.
