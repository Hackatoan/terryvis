import tempfile
import os
from flask import Flask, request, jsonify
import whisper
import numpy as np
import soundfile as sf

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
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "tiny.en")
print(f"[WHISPER] Loading model: {WHISPER_MODEL}")
model = whisper.load_model(WHISPER_MODEL)

# Simple in-memory queue for transcription jobs
MAX_QUEUE_SIZE = 6
JOB_TIMEOUT = 20  # seconds
transcribe_queue = queue.Queue()

def transcribe_worker():
    while True:
        job = transcribe_queue.get()
        if job is None:
            break
        req, arr, tmp_name, respond = job
        print(f"[WHISPER QUEUE] Processing job. Queue size: {transcribe_queue.qsize()}")
        try:
            # Run transcribe with a timeout via thread
            result_holder = {}
            def do_transcribe():
                try:
                    # Minimal options to avoid over-filtering
                    result_holder['result'] = model.transcribe(
                        tmp_name,
                        language='en',
                        fp16=False,
                        condition_on_previous_text=False,
                        temperature=0.0
                    )
                except Exception as e:
                    import traceback
                    tb = traceback.format_exc()
                    print(f"[WHISPER ERROR] {e}\n{tb}")
                    result_holder['error'] = str(e)
            t = threading.Thread(target=do_transcribe)
            t.start()
            t.join(JOB_TIMEOUT)
            if t.is_alive():
                respond({"error": f"Transcription timed out after {JOB_TIMEOUT}s"}, 504)
                print(f"[WHISPER QUEUE] Job timed out after {JOB_TIMEOUT}s")
            elif 'error' in result_holder:
                respond({"error": result_holder['error']}, 500)
            else:
                result = result_holder['result']
                text = (result.get("text") or "").strip()
                respond({"text": text}, 200)
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
        print(f"[WHISPER QUEUE] New job. Queue size: {qsize}")
        if qsize >= MAX_QUEUE_SIZE:
            print(f"[WHISPER QUEUE] Queue full. Dropping oldest job.")
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
                print(f"[WHISPER QUEUE] Error dropping old job: {e}")
        transcribe_queue.put((request, arr, tmp.name, respond))
        # Wait for the worker to process, with timeout
        if not done.wait(JOB_TIMEOUT + 5):
            print(f"[WHISPER QUEUE] Job response timed out after {JOB_TIMEOUT+5}s")
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
    return jsonify({
        "ok": True,
        "endpoint": "/transcribe",
        "model": WHISPER_MODEL
    }), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5005)

