// Robust socket with auto-reconnect
const socket = io({ transports: ['websocket'], reconnection: true, reconnectionDelay: 500, reconnectionAttempts: Infinity });

// Live transcript UI with backfill
const transcriptDiv = document.getElementById('transcript');
let transcriptLines = [];
function renderTranscript() {
  transcriptDiv.innerHTML = transcriptLines.join('<br>');
  transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
}
socket.on('transcript', ({ userId, username, text, timestamp }) => {
  transcriptLines.push(`<b>${username || 'User'}:</b> ${text}`);
  if (transcriptLines.length > 100) transcriptLines.shift();
  renderTranscript();
});
socket.on('transcripts_recent', (items) => {
  if (!Array.isArray(items)) return;
  // Sort by timestamp ascending and render last ~100
  items.sort((a,b) => (a.timestamp||0)-(b.timestamp||0));
  transcriptLines = items.slice(-100).map(({ username, text }) => `<b>${username || 'User'}:</b> ${text}`);
  renderTranscript();
});

// Clips list with Discord URLs, sorted newest first
const clipsDiv = document.getElementById('clips');
let clipItems = [];
function renderClips() {
  const sorted = clipItems.slice().sort((a,b) => (b.timestamp||0)-(a.timestamp||0));
  clipsDiv.innerHTML = sorted.map(c => {
    const d = new Date(c.timestamp||Date.now());
    const when = d.toLocaleString();
    const urlEsc = c.url.replace(/"/g, '&quot;');
    return `<div class="clip-item" style="margin:10px 0;display:flex;flex-direction:column;gap:6px;">`+
      `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">`+
        `<a href="${urlEsc}" target="_blank" rel="noopener" style="color:#58a6ff;">Clip (${when})</a>`+
        `<button class="copy-btn" data-url="${urlEsc}" style="padding:2px 8px;border-radius:6px;background:#3a3f44;color:#fff;border:1px solid #555;cursor:pointer;">Copy</button>`+
        (c.username ? ` <span style="opacity:0.7">by ${c.username}</span>` : '')+
      `</div>`+
      `<audio controls preload="none" controlslist="nodownload noplaybackrate" style="width:100%;max-width:560px;outline:none;">`+
        `<source src="${urlEsc}" type="audio/wav">`+
        `Your browser does not support the audio element.`+
      `</audio>`+
    `</div>`;
  }).join('');
}
socket.on('clips_recent', (items) => {
  if (!Array.isArray(items)) return;
  clipItems = items;
  renderClips();
});
socket.on('clip_posted', (clip) => {
  if (!clip || !clip.url) return;
  clipItems.push(clip);
  if (clipItems.length > 200) clipItems.shift();
  renderClips();
});

// Copy button handling (event delegation)
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const url = btn.getAttribute('data-url');
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied');
  } catch (_) {
    // Fallback: create a temp input
    const inp = document.createElement('input');
    inp.value = url;
    document.body.appendChild(inp);
    inp.select();
    document.execCommand('copy');
    document.body.removeChild(inp);
    showToast('Link copied');
  }
});

// Simple toast
let toastEl;
function ensureToast() {
  if (toastEl) return toastEl;
  toastEl = document.createElement('div');
  toastEl.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:8px 14px;border-radius:8px;opacity:0;transition:opacity .2s;z-index:2000;border:1px solid #333';
  document.body.appendChild(toastEl);
  return toastEl;
}
function showToast(msg) {
  const el = ensureToast();
  el.textContent = msg || '';
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 1200);
}

// Wire up Clip button to request a server-side clip
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('clip-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      try {
        socket.emit('clip_request', {});
        showToast('Clipping last 30s...');
      } catch (_) {}
    });
  }
});

// Connection lifecycle handling
socket.on('connect_error', () => {
  // force reconnect
  try { socket.connect(); } catch (e){}
});
socket.on('reconnect_attempt', () => {
  // NOP: rely on built-in backoff
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
