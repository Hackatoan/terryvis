# TerryVis

A Discord voice bot that streams audio to a web UI, transcribes speech using a local Vosk-based ASR server, and creates 30s clips via command or voice triggers.

## Features
- Joins the most active voice channel and streams audio to the browser
- Per-user 30s ring buffers and time-aligned mixing for clean clips
- Commands:
  - `-help` | `-commands`
  - `-clip`
  - `-dmtoggle`
  - `-setclip <channel_id|#mention>` (server owner only)
 - Voice trigger: say exactly "terry clip that" to create a clip (detection is strict).
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
 - `WHISPER_URL` / `ASR_URL` (defaults to http://127.0.0.1:5005; server also accepts `/transcribe`)
 - `VOSK_MODEL` (for the Python server; default ./models/vosk-model-small-en-us-0.15)

4. Python deps

It's recommended to use a virtual environment.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

5. Start the ASR server (Vosk)

```bash
python whisper_server.py
```

- It will start on `http://localhost:5005` and expose `POST /transcribe`.
- The server also accepts `POST /` as an alias and supports `.env` via `python-dotenv`.
- Point `VOSK_MODEL` at a downloaded Vosk model directory (see below).

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
  - Optional: `CLIPS_CHANNEL_ID`, `PORT` (for web UI), `ASR_URL`/`WHISPER_URL`, `VOSK_MODEL`.
  - When using Docker Compose, `ASR_URL`/`WHISPER_URL` defaults to `http://asr:5005`.

2. Start with Compose:

```bash
docker compose up --build
```

Services:
- asr: Python Vosk ASR server on port 5005 (exposed)
- bot: Node bot + web UI on port 3000 (exposed)

The clips folder is mounted at `./public/clips` for persistence.

 - If you see 404s on the ASR server, ensure the bot `ASR_URL` (or `WHISPER_URL` for backward compatibility) points to `/transcribe` or use the root alias (`/`).
 - Ensure your bot token is correct and that the bot is not blocked by server permissions.
 - For better transcription quality with Vosk, try a larger Vosk model (if available) or tune the grammar and noise-gate thresholds.

Docker notes and quick setup

- The included `docker-compose.yml` exposes environment variables for easy configuration. Create a `.env` file in the project root (it is `.gitignore`d) and set values there. Example `.env` entries:

```dotenv
DISCORD_TOKEN=your-bot-token
ASR_ENGINE=vosk
VOSK_MODEL=./models/vosk-model-small-en-us-0.15
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

To run only the bot with a locally-mounted Vosk model (no ASR container), set `ASR_ENGINE=vosk` and ensure `VOSK_MODEL` points to a valid model path on the host. The compose file uses the `asr` service name by default; remove or adapt it if you prefer a single-container setup.

### Faster / lower-resource ASR (Vosk)

This project uses Vosk by default for faster, lower-resource transcription. Vosk has small English models that run faster on CPUs and work well for short voice commands.

Install Vosk and a small English model:

```bash
pip install vosk
# download a small model (example):
mkdir -p models && cd models
wget https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip
unzip vosk-model-small-en-us-0.15.zip
cd ..
```

Set environment variables before starting the ASR server/bot:

```bash
export VOSK_MODEL=./models/vosk-model-small-en-us-0.15
python whisper_server.py
```

Vosk trades some accuracy for speed but is generally more responsive for short spoken commands.

## Improving Vosk accuracy (practical options)

If you want a step-up in accuracy, here are the most effective options (ordered by impact):

- Use a larger Vosk model (recommended): replace the small model with a medium/large English model. Larger models are noticeably more accurate at the cost of CPU and RAM. Example (host):

```bash
mkdir -p models && cd models
# medium model (example name — consult Vosk downloads for exact names/URLs)
wget https://alphacephei.com/vosk/models/vosk-model-medium-en-us-0.22.zip
unzip vosk-model-medium-en-us-0.22.zip
cd ..
export VOSK_MODEL=./models/vosk-model-medium-en-us-0.22
python whisper_server.py
```

- Tune the bot energy gate: `TRIGGER_MIN_ENERGY` (env or `.env`) avoids firing on low-energy audio. Raise it (e.g. `0.03`–`0.06`) to reduce accidental triggers, lower it to be more permissive.

- Grammar-focused detection: for short command-spotting keep a narrow grammar (we already use `["terry clip that"]`). If you want slightly more robustness, you can expand the grammar with carefully chosen variants (but that increases false-positive risk).

- Advanced Vosk decoder tuning: Vosk/Kaldi expose decoder parameters such as beam and max-active which can improve accuracy at the cost of CPU. These are not always exposed directly in the simple Python wrapper; however you can experiment with these environment variables (some builds read them) or run a custom container that sets them. Example envs (documented in `.env.example`):

```
VOSK_BEAM=15
VOSK_MAX_ACTIVE=7000
```

Note: changing decoder internals may require rebuilding Vosk or running a different Vosk runtime image; the fastest, most reliable step is to switch to a larger model.

If you'd like, I can download a medium model into `./models`, update `VOSK_MODEL` in your `.env`, and restart the ASR server here so you can test accuracy immediately. This will use more disk and CPU.
