import tempfile
import os
import threading
import queue
from flask import Flask, request, jsonify
import numpy as np
import soundfile as sf
import webrtcvad

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

app = Flask(__name__)

# Use faster-whisper instead of Vosk
ASR_ENGINE = 'faster-whisper'
try:
    from faster_whisper import WhisperModel
    MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base.en")
    # For CPU usage; change to 'cuda' and 'float16' if GPU is available
    print(f"[ASR] Loading faster-whisper model: {MODEL_SIZE}")
    whisper_model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
except Exception as e:
    print('[ASR] faster-whisper initialization failed:', e)
    whisper_model = None

MAX_QUEUE_SIZE = 6
JOB_TIMEOUT = 20
transcribe_queue = queue.Queue()

# Initialize VAD
vad = webrtcvad.Vad()
vad.set_mode(2) # 0 is least aggressive, 3 is most aggressive about filtering out non-speech

def frame_generator(frame_duration_ms, audio, sample_rate):
    n = int(sample_rate * (frame_duration_ms / 1000.0))
    offset = 0
    while offset + n <= len(audio):
        yield audio[offset:offset + n]
        offset += n

def contains_speech(audio_data, sample_rate=16000):
    # WebRTC VAD requires 16000Hz, 16-bit mono PCM. Frames must be 10, 20, or 30 ms.
    # Convert numpy array to bytes
    audio_bytes = audio_data.tobytes()
    frames = list(frame_generator(30, audio_bytes, sample_rate))

    if not frames:
        return False

    speech_frames = 0
    for frame in frames:
        if vad.is_speech(frame, sample_rate):
            speech_frames += 1

    # If at least 20% of frames contain speech, consider it valid speech
    return (speech_frames / len(frames)) > 0.2

def transcribe_worker():
    while True:
        job = transcribe_queue.get()
        if job is None:
            break

        req, arr, tmp_name, respond = job
        print(f"[ASR QUEUE] Processing job. Queue size: {transcribe_queue.qsize()}")

        try:
            if whisper_model is not None:
                # Transcribe using faster-whisper
                segments, info = whisper_model.transcribe(tmp_name, beam_size=5, vad_filter=True)
                text_out = " ".join([segment.text for segment in segments])
                text = text_out.strip()
                respond({"text": text}, 200)
            else:
                respond({"error": "faster-whisper model unavailable."}, 500)
        except Exception as e:
            respond({"error": str(e)}, 500)
        finally:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)
            transcribe_queue.task_done()

worker_thread = threading.Thread(target=transcribe_worker, daemon=True)
worker_thread.start()

@app.route('/transcribe', methods=['POST'])
def transcribe():
    audio_bytes = request.data
    if not audio_bytes or len(audio_bytes) < 128:
        return jsonify({"error": "No or too little audio received"}), 400

    arr = np.frombuffer(audio_bytes, dtype=np.int16)
    if arr.size == 0 or np.all(arr == 0):
        return jsonify({"error": "Audio data is empty or silent"}), 400

    if arr.size < 3200:
        return jsonify({"error": "Audio data too short (<0.2s)"}), 204

    # Use VAD instead of simple energy gate
    if not contains_speech(arr):
        return jsonify({"error": "No speech detected by VAD"}), 204

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        sf.write(tmp.name, arr, 16000, subtype='PCM_16')

        done = threading.Event()
        response = {}
        status = [200]

        def respond(data, code):
            response['data'] = data
            status[0] = code
            done.set()

        qsize = transcribe_queue.qsize()
        if qsize >= MAX_QUEUE_SIZE:
            try:
                for _ in range(qsize - MAX_QUEUE_SIZE + 1):
                    old_job = transcribe_queue.get_nowait()
                    _, _, old_tmp_name, old_respond = old_job
                    if os.path.exists(old_tmp_name):
                        os.unlink(old_tmp_name)
                    old_respond({"error": "Dropped due to queue overflow"}, 429)
                    transcribe_queue.task_done()
            except Exception:
                pass

        transcribe_queue.put((request, arr, tmp.name, respond))

        if not done.wait(JOB_TIMEOUT + 5):
            os.unlink(tmp.name)
            return jsonify({"error": f"Server response timed out after {JOB_TIMEOUT+5}s"}), 504

        return jsonify(response['data']), status[0]

@app.route('/', methods=['POST'])
def root_post():
    return transcribe()

@app.route('/', methods=['GET'])
def root_get():
    info = {
        "ok": True,
        "endpoint": "/transcribe",
        "engine": ASR_ENGINE,
        "model": os.environ.get("WHISPER_MODEL", "base.en")
    }
    return jsonify(info), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5005)
