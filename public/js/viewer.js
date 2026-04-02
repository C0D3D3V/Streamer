'use strict';

// Determine context: shared page or admin viewer
const slug = window.SHARE_SLUG || null;
const params = new URLSearchParams(location.search);
const streamId = params.get('id') || null;

const video = document.getElementById('video');
const resSelect = document.getElementById('res-select');
const btnLive = document.getElementById('btn-live');
const liveBadge = document.getElementById('live-badge');
const vodBadge = document.getElementById('vod-badge');
const overlayMsg = document.getElementById('overlay-msg');
const resumeBar = document.getElementById('resume-bar');
const resumeMsg = document.getElementById('resume-msg');
const btnResume = document.getElementById('btn-resume');
const btnDismiss = document.getElementById('btn-dismiss');
const streamNameEl = document.getElementById('stream-name');
const btnDownload = document.getElementById('btn-download');

let hls = null;
let currentRes = localStorage.getItem('preferred_quality') || 'master';
let savedPosition = null;
let currentStreamId = streamId;
let isLiveStream = false;
let mp4PollInterval = null;

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  if (slug) {
    // Shared page: load stream info via API
    const res = await fetch(`/api/share/${slug}/status`);
    if (!res.ok) { showOverlay('Stream not found'); return; }
    const data = await res.json();
    currentStreamId = data.streamId;
    isLiveStream = data.isLive;
    if (streamNameEl) streamNameEl.textContent = data.streamName;
    checkMp4Status(data.mp4Status);
  } else if (streamId) {
    // Admin viewer
    const res = await fetch(`/api/admin/streams/${streamId}`);
    if (!res.ok) { showOverlay('Stream not found'); return; }
    const data = await res.json();
    isLiveStream = !data.ended_at;
    if (streamNameEl) streamNameEl.textContent = data.name;
    checkMp4Status(data.mp4_status);
  } else {
    showOverlay('No stream specified');
    return;
  }

  resSelect.value = currentRes;
  checkResumePosition();
  loadStream(currentRes);
}

function hlsUrl(res) {
  const base = slug
    ? `/hls/share/${slug}/`
    : `/hls/${currentStreamId}/`;
  if (res === 'master') return base + 'master.m3u8';
  return base + `${res}/playlist.m3u8`;
}

function loadStream(res) {
  currentRes = res;
  localStorage.setItem('preferred_quality', res);

  if (hls) { hls.destroy(); hls = null; }

  const url = hlsUrl(res);

  if (Hls.isSupported()) {
    hls = new Hls({
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 6,
      enableWorker: true,
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, onManifestParsed);
    hls.on(Hls.Events.ERROR, onHlsError);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.addEventListener('loadedmetadata', onManifestParsed, { once: true });
  } else {
    showOverlay('HLS not supported in this browser');
  }
}

function onManifestParsed() {
  updateLiveBadge();
  if (savedPosition !== null) {
    // Resume bar already shown — wait for user interaction
  } else {
    video.play().catch(() => {});
  }
  startPositionSaver();
}

function updateLiveBadge() {
  if (!isLiveStream) {
    if (liveBadge) liveBadge.classList.add('hidden');
    if (vodBadge) vodBadge.classList.remove('hidden');
    if (btnLive) btnLive.classList.add('hidden');
    return;
  }
  if (liveBadge) liveBadge.classList.remove('hidden');
  if (vodBadge) vodBadge.classList.add('hidden');
  // Show "Go Live" button when seeking back
  video.addEventListener('seeking', checkLiveEdge);
  video.addEventListener('timeupdate', checkLiveEdge);
}

function checkLiveEdge() {
  if (!hls || !isLiveStream) return;
  const duration = video.duration;
  const current = video.currentTime;
  const atLive = duration - current < 15;
  if (btnLive) btnLive.classList.toggle('hidden', atLive);
}

btnLive && btnLive.addEventListener('click', () => {
  if (hls) {
    hls.startLoad(-1);
    video.currentTime = video.duration;
  }
  video.play().catch(() => {});
});

// ── Resume position ───────────────────────────────────────────────────────────
function storageKey() { return `stream_pos_${currentStreamId}`; }

function checkResumePosition() {
  const stored = localStorage.getItem(storageKey());
  if (!stored) return;
  const pos = parseFloat(stored);
  if (isNaN(pos) || pos < 5) return;
  savedPosition = pos;
  const mins = Math.floor(pos / 60);
  const secs = Math.floor(pos % 60).toString().padStart(2, '0');
  resumeMsg.textContent = `Resume from ${mins}:${secs}?`;
  resumeBar.classList.remove('hidden');
}

btnResume && btnResume.addEventListener('click', () => {
  resumeBar.classList.add('hidden');
  video.addEventListener('canplay', () => {
    video.currentTime = savedPosition;
    video.play().catch(() => {});
  }, { once: true });
  savedPosition = null;
});

btnDismiss && btnDismiss.addEventListener('click', () => {
  resumeBar.classList.add('hidden');
  savedPosition = null;
  localStorage.removeItem(storageKey());
  video.play().catch(() => {});
});

function startPositionSaver() {
  setInterval(() => {
    if (!video.paused && video.currentTime > 5) {
      localStorage.setItem(storageKey(), video.currentTime.toFixed(1));
    }
  }, 5000);
  // Clear near the end (VOD)
  video.addEventListener('ended', () => localStorage.removeItem(storageKey()));
}

// ── Resolution selector ───────────────────────────────────────────────────────
resSelect.addEventListener('change', () => {
  const pos = video.currentTime;
  const wasPlaying = !video.paused;
  loadStream(resSelect.value);
  hls ? hls.once(Hls.Events.MANIFEST_PARSED, () => {
    video.currentTime = pos;
    if (wasPlaying) video.play().catch(() => {});
  }) : null;
});

// ── HLS error handling ────────────────────────────────────────────────────────
function onHlsError(event, data) {
  if (data.fatal) {
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      setTimeout(() => hls && hls.startLoad(), 3000);
    } else {
      hls.destroy();
    }
  }
}

// ── MP4 download button ───────────────────────────────────────────────────────
function checkMp4Status(status) {
  if (!btnDownload) return;
  if (status === 'done') {
    const href = slug ? `/download/share/${slug}` : `/download/${currentStreamId}`;
    btnDownload.href = href;
    btnDownload.classList.remove('hidden');
  } else if (status === 'converting' || status === 'pending') {
    startMp4Poll();
  }
}

function startMp4Poll() {
  if (mp4PollInterval) return;
  mp4PollInterval = setInterval(async () => {
    const url = slug
      ? `/api/share/${slug}/mp4status`
      : `/api/admin/streams/${currentStreamId}/mp4status`;
    const res = await fetch(url).catch(() => null);
    if (!res || !res.ok) return;
    const { status } = await res.json();
    if (status === 'done') {
      clearInterval(mp4PollInterval);
      checkMp4Status('done');
    }
  }, 10000);
}

// ── Overlay ───────────────────────────────────────────────────────────────────
function showOverlay(msg) {
  overlayMsg.textContent = msg;
  overlayMsg.classList.remove('hidden');
}

init();
