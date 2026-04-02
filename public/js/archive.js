'use strict';

let shareTargetStreamId = null;

(async function init() {
  const meRes = await fetch('/auth/me');
  if (!meRes.ok) { location.href = '/auth/login'; return; }
  const { user } = await meRes.json();
  document.getElementById('user-name').textContent = user.name;
  await loadArchive();
})();

async function loadArchive() {
  const res = await fetch('/api/admin/streams');
  if (!res.ok) return;
  const streams = await res.json();
  renderArchive(streams.filter(s => s.ended_at));
}

function renderArchive(streams) {
  const el = document.getElementById('archive-list');
  if (!streams.length) { el.innerHTML = '<p class="muted">No recordings yet.</p>'; return; }

  el.innerHTML = streams.map(s => {
    const date = new Date(s.started_at).toLocaleString();
    const duration = s.ended_at
      ? formatDuration((s.ended_at - s.started_at) / 1000)
      : '';

    const downloadBtn = s.mp4_status === 'done'
      ? `<a href="/download/${s.id}" class="btn btn-sm">Download MP4</a>`
      : s.mp4_status === 'converting'
        ? `<span class="badge-converting" data-id="${s.id}">Converting…</span>`
        : `<span class="muted badge-converting" data-id="${s.id}">Pending MP4</span>`;

    return `<div class="archive-row">
      <div class="archive-thumb">
        <div class="thumb-placeholder">&#9654;</div>
      </div>
      <div class="archive-info">
        <strong class="archive-title">${esc(s.name)}</strong>
        <span class="muted">${date} &mdash; ${duration}</span>
      </div>
      <div class="archive-actions">
        <a href="/viewer/?id=${s.id}" target="_blank" class="btn btn-sm">Watch</a>
        <button class="btn btn-sm" onclick="openShareModal('${s.id}')">Share</button>
        ${downloadBtn}
      </div>
    </div>`;
  }).join('');

  // Poll converting items
  document.querySelectorAll('.badge-converting[data-id]').forEach(el => {
    pollMp4(el.dataset.id, el);
  });
}

function pollMp4(streamId, el) {
  const interval = setInterval(async () => {
    const res = await fetch(`/api/admin/streams/${streamId}/mp4status`).catch(() => null);
    if (!res || !res.ok) return;
    const { status } = await res.json();
    if (status === 'done') {
      clearInterval(interval);
      const link = document.createElement('a');
      link.href = `/download/${streamId}`;
      link.className = 'btn btn-sm';
      link.textContent = 'Download MP4';
      el.replaceWith(link);
    }
  }, 10000);
}

// ── Share modal ───────────────────────────────────────────────────────────────
function openShareModal(streamId) {
  shareTargetStreamId = streamId;
  document.getElementById('share-result').classList.add('hidden');
  document.getElementById('share-slug-input').value = '';
  document.getElementById('share-password-input').value = '';
  document.getElementById('share-modal').classList.remove('hidden');
}

document.getElementById('btn-create-share').addEventListener('click', async () => {
  if (!shareTargetStreamId) return;
  const slug = document.getElementById('share-slug-input').value.trim();
  const password = document.getElementById('share-password-input').value;

  const res = await fetch(`/api/admin/streams/${shareTargetStreamId}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: slug || undefined, password: password || undefined }),
  });

  if (!res.ok) {
    const err = await res.json();
    alert(err.error || 'Failed');
    return;
  }

  const { url } = await res.json();
  const fullUrl = `${location.origin}${url}`;
  document.getElementById('share-url-display').value = fullUrl;
  document.getElementById('share-result').classList.remove('hidden');
});

document.getElementById('btn-copy-url').addEventListener('click', () => {
  const inp = document.getElementById('share-url-display');
  inp.select();
  navigator.clipboard.writeText(inp.value).catch(() => document.execCommand('copy'));
});

document.getElementById('btn-modal-close').addEventListener('click', () => {
  document.getElementById('share-modal').classList.add('hidden');
  shareTargetStreamId = null;
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
