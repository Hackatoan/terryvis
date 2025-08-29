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
- Voice trigger: say variants like "Terry clip that", "Okay Terry, clip that", "re-clip that", or split phrases within a few seconds.

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
