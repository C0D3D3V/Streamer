'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let mediaStream = null;
let audioContext = null;
let gainNode = null;
let mediaRecorder = null;
let ws = null;
let streaming = false;
let startTime = null;
let bytesSent = 0;
let statsInterval = null;

// ── Elements ──────────────────────────────────────────────────────────────────
const preview       = document.getElementById('preview');
const statusChip    = document.getElementById('status-chip');
const recIndicator  = document.getElementById('rec-indicator');
const streamSelect  = document.getElementById('stream-select');
const qualitySelect = document.getElementById('quality-select');
const cameraSelect  = document.getElementById('camera-select');
const gainSlider    = document.getElementById('gain-slider');
const gainValue     = document.getElementById('gain-value');
const btnStream     = document.getElementById('btn-stream');
const btnRefresh    = document.getElementById('btn-refresh-streams');
const streamStats   = document.getElementById('stream-stats');
const statDuration  = document.getElementById('stat-duration');
const statBytes     = document.getElementById('stat-bytes');

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  const meRes = await fetch('/auth/me');
  if (!meRes.ok) { location.href = '/auth/login'; return; }

  await loadStreams();
  await startPreview();
})();

// ── Camera preview ────────────────────────────────────────────────────────────
async function startPreview() {
  const quality = qualitySelect.value;
  const facing = cameraSelect.value;
  const heights = { '1080': 1080, '720': 720, '480': 480 };
  const h = heights[quality];
  const isLandscape = window.innerWidth > window.innerHeight;

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: facing,
        width:  { ideal: isLandscape ? Math.round(h * 16 / 9) : h },
        height: { ideal: isLandscape ? h : Math.round(h * 16 / 9) },
        frameRate: { ideal: 30 },
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    preview.srcObject = mediaStream;
    preview.addEventListener('loadedmetadata', applyPreviewRotation, { once: true });
  } catch (err) {
    setStatus('Camera error', 'error');
    console.error(err);
  }
}

function applyPreviewRotation() {
  const vw = preview.videoWidth;
  const vh = preview.videoHeight;
  if (!vw || !vh) return;

  const phoneLandscape = window.innerWidth > window.innerHeight;
  const videoLandscape = vw > vh;

  // Reset inline styles first
  preview.style.cssText = '';

  if (phoneLandscape === videoLandscape) return; // orientations match — nothing to do

  // Video orientation doesn't match the phone — rotate it to compensate.
  // landscape-secondary means the phone was rotated the other way.
  const secondary = screen.orientation?.type?.includes('secondary');
  const deg = phoneLandscape ? (secondary ? -90 : 90) : (secondary ? 90 : -90);

  const wrap = preview.parentElement;
  // After rotation the video's layout width/height are swapped, so set them
  // to the container's h×w so the rotated result fills w×h exactly.
  preview.style.position  = 'absolute';
  preview.style.top       = '50%';
  preview.style.left      = '50%';
  preview.style.width     = wrap.clientHeight + 'px';
  preview.style.height    = wrap.clientWidth  + 'px';
  preview.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
  preview.style.objectFit = 'cover';
}

cameraSelect.addEventListener('change', () => { if (!streaming) startPreview(); });
qualitySelect.addEventListener('change', () => { if (!streaming) startPreview(); });

// ── Gain control ──────────────────────────────────────────────────────────────
gainSlider.addEventListener('input', () => {
  const pct = parseInt(gainSlider.value);
  gainValue.textContent = `${pct}%`;
  if (gainNode) gainNode.gain.value = pct / 100;
});

// ── Streams list ──────────────────────────────────────────────────────────────
async function loadStreams() {
  const res = await fetch('/api/admin/streams').catch(() => null);
  if (!res || !res.ok) return;
  const streams = await res.json();
  const live = streams.filter(s => !s.ended_at);

  streamSelect.innerHTML = '<option value="">-- Select active stream --</option>';
  live.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    streamSelect.appendChild(opt);
  });
}

btnRefresh.addEventListener('click', loadStreams);

// ── Stream start / stop ───────────────────────────────────────────────────────
btnStream.addEventListener('click', async () => {
  if (streaming) {
    stopStreaming();
  } else {
    await startStreaming();
  }
});

async function startStreaming() {
  const streamId = streamSelect.value;
  if (!streamId) { alert('Select a stream first'); return; }
  if (!mediaStream) { alert('Camera not ready'); return; }

  // Build WebSocket URL
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProto}//${location.host}/ingest/${streamId}`;

  ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setStatus('Live', 'live');
    recIndicator.classList.remove('hidden');
    streaming = true;
    btnStream.textContent = 'Stop Streaming';
    btnStream.classList.remove('btn-primary');
    btnStream.classList.add('btn-danger');
    startTime = Date.now();
    bytesSent = 0;
    streamStats.classList.remove('hidden');
    startStats();
    beginRecording();
  };

  ws.onerror = (err) => {
    console.error('WS error', err);
    stopStreaming();
    setStatus('Connection error', 'error');
  };

  ws.onclose = () => {
    if (streaming) {
      setStatus('Disconnected', 'error');
      stopStreaming();
    }
  };
}

function beginRecording() {
  // Route audio through Web Audio for gain control
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);
  gainNode = audioContext.createGain();
  gainNode.gain.value = parseInt(gainSlider.value) / 100;
  const dest = audioContext.createMediaStreamDestination();
  source.connect(gainNode);
  gainNode.connect(dest);

  // Combine processed audio with original video tracks
  const processedStream = new MediaStream([
    ...mediaStream.getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);

  // Pick best supported codec
  const mimeTypes = [
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const mimeType = mimeTypes.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';

  mediaRecorder = new MediaRecorder(processedStream, {
    mimeType,
    videoBitsPerSecond: 4_000_000,
    audioBitsPerSecond: 192_000,
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0 && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(e.data);
      bytesSent += e.data.size;
    }
  };

  mediaRecorder.start(250); // 250ms chunks for low latency
}

function stopStreaming() {
  streaming = false;

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
    gainNode = null;
  }

  if (ws) {
    ws.close();
    ws = null;
  }

  clearInterval(statsInterval);
  statsInterval = null;

  recIndicator.classList.add('hidden');
  streamStats.classList.add('hidden');
  btnStream.textContent = 'Start Streaming';
  btnStream.classList.add('btn-primary');
  btnStream.classList.remove('btn-danger');
  setStatus('Idle', 'idle');
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function startStats() {
  statsInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = (elapsed % 60).toString().padStart(2, '0');
    statDuration.textContent = `${m}:${s}`;
    statBytes.textContent = `${(bytesSent / 1024 / 1024).toFixed(1)} MB`;
  }, 1000);
}

// ── Status chip ───────────────────────────────────────────────────────────────
function setStatus(text, type) {
  statusChip.textContent = text;
  statusChip.className = `status-chip status-${type}`;
}

// ── Orientation change → reconnect ────────────────────────────────────────────
if (screen.orientation) {
  screen.orientation.addEventListener('change', async () => {
    if (!streaming) {
      // Just restart the preview with the new orientation
      startPreview();
      return;
    }
    // While live: stop → restart preview → reconnect WebSocket
    // The server skips finalization if a new connection arrives within 3 s.
    setStatus('Reconnecting…', 'idle');
    stopStreaming();
    await startPreview();
    // Small delay so the browser can capture the first rotated frame before we send
    setTimeout(() => startStreaming(), 300);
  });
}

// ── Screen wake lock (keep screen on while streaming) ────────────────────────
let wakeLock = null;
document.addEventListener('visibilitychange', async () => {
  if (streaming && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
});
btnStream.addEventListener('click', async () => {
  if (!streaming && 'wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  } else if (!streaming && wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
});
