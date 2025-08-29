const socket = io();
// Live transcript UI
const transcriptDiv = document.getElementById('transcript');
let transcriptLines = [];
socket.on('transcript', ({ userId, username, text }) => {
  transcriptLines.push(`<b>${username}:</b> ${text}`);
  if (transcriptLines.length > 30) transcriptLines.shift();
  transcriptDiv.innerHTML = transcriptLines.join('<br>');
  transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
});
// This is a placeholder for browser-side Opus decoding and playback.
// In production, you would use a library like opus-recorder, or a WASM Opus decoder.
// For now, we will just log incoming audio packets per user.

// --- Audio Setup ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
window.addEventListener('click', () => {
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}, { once: true });

// Per-user PCM sample buffers (Int16 stereo interleaved)
const userBuffers = {}; // userId -> Int16Array of samples (L,R interleaved)
const SAMPLE_RATE = 48000;
const BUFFER_SIZE = 4096; // frames per onaudioprocess
const JITTER_MS = 30; // initial buffering before playback start
const JITTER_FRAMES = Math.ceil((SAMPLE_RATE * JITTER_MS) / 1000);
let jitterReady = false;
const CHANNELS = 2;
let playMode = 'all'; // 'all' or userId

function updateSelectionStyles() {
  const channelEl = document.getElementById('channel');
  const memberEls = document.querySelectorAll('.member');
  if (playMode === 'all') {
    channelEl.style.textDecoration = 'underline';
    memberEls.forEach(div => div.style.textDecoration = 'none');
  } else {
    channelEl.style.textDecoration = 'none';
    memberEls.forEach(div => {
      div.style.textDecoration = (div.dataset.userid === playMode) ? 'underline' : 'none';
    });
  }
}

// UI event handlers for selecting audio
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('channel').addEventListener('click', () => {
    playMode = 'all';
  updateSelectionStyles();
  resetJitter();
  });
});

function setUserClickHandlers() {
  document.querySelectorAll('.member').forEach(div => {
    div.onclick = () => {
      playMode = div.dataset.userid;
  updateSelectionStyles();
  resetJitter();
    };
  });
}

// Audio mixing and playback
let scriptNode = null;
function startAudioNode() {
  if (scriptNode) return;
  scriptNode = audioCtx.createScriptProcessor(BUFFER_SIZE, 0, CHANNELS);
  scriptNode.onaudioprocess = (e) => {
    // Wait for jitter buffer to fill before starting playback
    if (!jitterReady) {
      let ready = false;
      if (playMode === 'all') {
        // Start as soon as any user has enough buffered
        ready = Object.values(userBuffers).some(samples => samples && samples.length >= JITTER_FRAMES * CHANNELS);
      } else {
        const samples = userBuffers[playMode];
        ready = samples && samples.length >= JITTER_FRAMES * CHANNELS;
      }
      if (ready) {
        jitterReady = true;
      } else {
        // Output silence until ready
        e.outputBuffer.getChannelData(0).fill(0);
        e.outputBuffer.getChannelData(1).fill(0);
        return;
      }
    }
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    outL.fill(0); outR.fill(0);
    if (playMode === 'all') {
      // Mix across users using available samples; apply simple limiter
      const neededSamples = BUFFER_SIZE * CHANNELS;
      // Build a map of per-user slices to consume this callback
      const slices = {};
      for (const userId in userBuffers) {
        const samples = userBuffers[userId];
        if (samples && samples.length >= neededSamples) {
          slices[userId] = samples.subarray(0, neededSamples);
        } else {
          slices[userId] = null; // insufficient data, treat as silence
        }
      }
      for (let j = 0; j < BUFFER_SIZE; j++) {
        let sumL = 0, sumR = 0, contributors = 0;
        for (const userId in slices) {
          const s = slices[userId];
          if (!s) continue;
          const idx = j * 2;
          sumL += s[idx];
          sumR += s[idx + 1];
          contributors++;
        }
        if (contributors > 0) {
          // Average to avoid clipping when multiple users are active
          sumL = sumL / contributors;
          sumR = sumR / contributors;
        }
        // Safety limiter
        if (sumL > 32767) sumL = 32767; else if (sumL < -32768) sumL = -32768;
        if (sumR > 32767) sumR = 32767; else if (sumR < -32768) sumR = -32768;
        outL[j] = sumL / 32768;
        outR[j] = sumR / 32768;
      }
      // Consume samples
      for (const userId in userBuffers) {
        const samples = userBuffers[userId];
        if (samples && samples.length >= neededSamples) {
          userBuffers[userId] = samples.subarray(neededSamples);
        }
      }
    } else {
      const samples = userBuffers[playMode];
      if (samples && samples.length >= BUFFER_SIZE * CHANNELS) {
        const slice = samples.subarray(0, BUFFER_SIZE * CHANNELS);
        for (let j = 0; j < BUFFER_SIZE; j++) {
          const idx = j * 2;
          outL[j] = slice[idx] / 32768;
          outR[j] = slice[idx + 1] / 32768;
        }
        userBuffers[playMode] = samples.subarray(BUFFER_SIZE * CHANNELS);
      }
    }
  };
  scriptNode.connect(audioCtx.destination);
}

socket.on('audio', ({ userId, data }) => {
  // Decode base64 to bytes
  const bytes = atob(data);
  const len = bytes.length;
  const buf = new Uint8Array(len);
  for (let i = 0; i < len; i++) buf[i] = bytes.charCodeAt(i);
  // Interpret as little-endian Int16 stereo
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  const existing = userBuffers[userId];
  if (existing && existing.length > 0) {
    // Concatenate efficiently using a new typed array
    const merged = new Int16Array(existing.length + samples.length);
    merged.set(existing, 0);
    merged.set(samples, existing.length);
    userBuffers[userId] = merged;
  } else {
    // Copy into a standalone Int16Array to avoid retaining the underlying Uint8Array buffer
    const copy = new Int16Array(samples.length);
    copy.set(samples);
    userBuffers[userId] = copy;
  }
  startAudioNode();
});

// Reset jitter buffer when switching modes
function resetJitter() {
  jitterReady = false;
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('channel').addEventListener('click', resetJitter);
});

socket.on('update', data => {
  if (data.channel) {
    document.getElementById('channel').textContent = `Channel: ${data.channel.name}`;
  } else {
    document.getElementById('channel').textContent = 'No channel';
  }
  const membersDiv = document.getElementById('members');
  membersDiv.innerHTML = '';
  (data.members || []).forEach(m => {
    const div = document.createElement('div');
    div.className = 'member';
    div.dataset.userid = m.id;
    div.innerHTML = `<img src="${m.avatar}" alt="avatar">${m.username}`;
    membersDiv.appendChild(div);
  });
  setUserClickHandlers();
  // Keep current selection unless the selected user left
  if (playMode !== 'all') {
    const stillPresent = (data.members || []).some(m => m.id === playMode);
    if (!stillPresent) playMode = 'all';
  }
  updateSelectionStyles();
});

// You would need to implement Opus decoding and playback here.
// See: https://github.com/discordjs/voice/blob/main/docs/examples/recorder.md
// Or use a WASM Opus decoder and Web Audio API.
