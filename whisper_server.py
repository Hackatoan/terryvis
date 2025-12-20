import tempfile
import os
from flask import Flask, request, jsonify
import numpy as np
import soundfile as sf
import json
import wave

import threading
import queue

# Load env from .env if python-dotenv is available (optional)
try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv()
except Exception:
    pass

app = Flask(__name__)
# Model from env (default tiny.en)
# We now run Vosk-only for faster, lightweight ASR optimized for short commands.
ASR_ENGINE = 'vosk'
try:
    from vosk import Model as VoskModel, KaldiRecognizer
except Exception as e:
    print('[ASR] `vosk` package not available:', e)
    print('[ASR] Install with: pip install vosk')
    vosk_model = None
else:
    VOSK_MODEL_PATH = os.environ.get('VOSK_MODEL', 'vosk-model-small-en-us-0.15')
    print(f"[ASR] Loading Vosk model from: {VOSK_MODEL_PATH}")
    if not os.path.exists(VOSK_MODEL_PATH):
        print('[ASR] Vosk model path does not exist; please download a model and set VOSK_MODEL env var')
        vosk_model = None
    else:
        try:
            vosk_model = VoskModel(VOSK_MODEL_PATH)
        except Exception as e:
            print('[ASR] Failed to initialize Vosk model:', e)
            vosk_model = None

# Simple in-memory queue for transcription jobs
MAX_QUEUE_SIZE = 6
JOB_TIMEOUT = 20  # seconds
transcribe_queue = queue.Queue()

def transcribe_worker():
    while True:
        job = transcribe_queue.get()
        if job is None:
            break
        # job tuple: (request, arr, tmp_name, respond, grammar)
        if len(job) == 5:
            req, arr, tmp_name, respond, grammar = job
        else:
            req, arr, tmp_name, respond = job
            grammar = None
        print(f"[ASR QUEUE] Processing job. Queue size: {transcribe_queue.qsize()}")
        try:
            if 'vosk_model' in globals() and vosk_model is not None:
                # Use Vosk recognizer (fast, CPU-friendly for small models)
                wf = wave.open(tmp_name, 'rb')
                if grammar:
                    rec = KaldiRecognizer(vosk_model, wf.getframerate(), grammar)
                else:
                    rec = KaldiRecognizer(vosk_model, wf.getframerate())
                rec.SetWords(False)
                text_out = ''
                while True:
                    data = wf.readframes(4000)
                    if len(data) == 0:
                        break
                    if rec.AcceptWaveform(data):
                        res = json.loads(rec.Result())
                        text_out += (res.get('text','') + ' ')
                final = json.loads(rec.FinalResult())
                text_out += final.get('text','')
                text = text_out.strip()
                respond({"text": text}, 200)
            else:
                respond({"error": "Vosk model unavailable. Set VOSK_MODEL to a valid model path and ensure `vosk` is installed."}, 500)
                continue
        except Exception as e:
            respond({"error": str(e)}, 500)
        finally:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)
            transcribe_queue.task_done()

# Start the worker thread
worker_thread = threading.Thread(target=transcribe_worker, daemon=True)
worker_thread.start()


@app.route('/transcribe', methods=['POST'])
def transcribe():
    audio_bytes = request.data
    if not audio_bytes or len(audio_bytes) < 128:
        print(f"[ERROR] No or too little audio received. Bytes: {len(audio_bytes) if audio_bytes else 0}")
        return jsonify({"error": "No or too little audio received"}), 400
    arr = np.frombuffer(audio_bytes, dtype=np.int16)
    if arr.size == 0:
        print(f"[ERROR] Audio data is empty. Bytes: {len(audio_bytes)}")
        return jsonify({"error": "Audio data is empty"}), 400
    if np.all(arr == 0):
        print(f"[ERROR] Audio data is all zeros (silent). Bytes: {len(audio_bytes)}")
        return jsonify({"error": "Audio data is silent"}), 400
    # Require at least ~0.2s of audio (3200 samples at 16kHz) for responsiveness
    if arr.size < 3200:
        # too short to be useful; treat as no-content
        return jsonify({"error": "Audio data too short (<0.2s)"}), 204

    # Basic noise gate on mean absolute amplitude (Int16 scale)
    mean_energy = float(np.mean(np.abs(arr)))
    NOISE_GATE = 6.0  # very permissive
    if mean_energy < NOISE_GATE:
        return jsonify({"error": "Below noise gate"}), 204
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        sf.write(tmp.name, arr, 16000, subtype='PCM_16')
        # Use a threading.Event to wait for the result
        done = threading.Event()
        response = {}
        status = [200]
        def respond(data, code):
            response['data'] = data
            status[0] = code
            done.set()
        # Enqueue the job, but limit queue size
        qsize = transcribe_queue.qsize()
        print(f"[ASR QUEUE] New job. Queue size: {qsize}")
        if qsize >= MAX_QUEUE_SIZE:
            print(f"[ASR QUEUE] Queue full. Dropping oldest job.")
            try:
                # Remove oldest job(s) to make room for the new one
                for _ in range(qsize - MAX_QUEUE_SIZE + 1):
                    old_job = transcribe_queue.get_nowait()
                    _, _, old_tmp_name, old_respond = old_job
                    if os.path.exists(old_tmp_name):
                        os.unlink(old_tmp_name)
                    old_respond({"error": "Dropped due to queue overflow"}, 429)
                    transcribe_queue.task_done()
            except Exception as e:
                print(f"[ASR QUEUE] Error dropping old job: {e}")
        grammar = request.headers.get('X-ASR-GRAMMAR') if hasattr(request, 'headers') else None
        transcribe_queue.put((request, arr, tmp.name, respond, grammar))
        # Wait for the worker to process, with timeout
        if not done.wait(JOB_TIMEOUT + 5):
            print(f"[ASR QUEUE] Job response timed out after {JOB_TIMEOUT+5}s")
            os.unlink(tmp.name)
            return jsonify({"error": f"Server response timed out after {JOB_TIMEOUT+5}s"}), 504
        return jsonify(response['data']), status[0]

# Accept POST / as alias to /transcribe to avoid 404s from clients posting to root
@app.route('/', methods=['POST'])
def root_post():
    return transcribe()

# Basic health/info endpoint at GET /
@app.route('/', methods=['GET'])
def root_get():
    info = {"ok": True, "endpoint": "/transcribe", "engine": ASR_ENGINE}
    info['model'] = os.environ.get('VOSK_MODEL', VOSK_MODEL_PATH if 'VOSK_MODEL_PATH' in globals() else None)
    return jsonify(info), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5005)

