'use strict';

let activeStreamId = null;
let ingestWs = null;

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  const meRes = await fetch('/auth/me');
  if (!meRes.ok) { location.href = '/auth/login'; return; }
  const { user } = await meRes.json();
  document.getElementById('user-name').textContent = user.name;

  const info = await fetch('/api/admin/info').then(r => r.json()).catch(() => ({}));
  if (info.encoder) {
    const chip = document.createElement('span');
    chip.className = 'encoder-chip';
    chip.title = 'Active video encoder';
    chip.textContent = info.encoder;
    document.getElementById('user-name').after(chip);
  }

  await loadStreams();
})();

// ── Streams list ──────────────────────────────────────────────────────────────
async function loadStreams() {
  const res = await fetch('/api/admin/streams');
  if (!res.ok) return;
  const streams = await res.json();
  renderStreamsList(streams);
}

function renderStreamsList(streams) {
  const el = document.getElementById('streams-list');
  if (!streams.length) { el.innerHTML = '<p class="muted">No streams yet.</p>'; return; }

  el.innerHTML = streams.map(s => {
    const date = new Date(s.started_at).toLocaleString();
    const status = s.ended_at ? 'Ended' : '<span class="badge-live">● LIVE</span>';
    const mp4 = s.mp4_status === 'done'
      ? `<a href="/download/${s.id}" class="btn btn-sm">Download MP4</a>`
      : s.mp4_status === 'converting'
        ? '<span class="muted">Converting…</span>'
        : '';

    return `<div class="stream-row">
      <div class="stream-info">
        <strong>${esc(s.name)}</strong>
        <span class="muted">${date}</span>
        ${status}
      </div>
      <div class="stream-actions">
        <a href="/viewer/?id=${s.id}" target="_blank" class="btn btn-sm">Watch</a>
        <button class="btn btn-sm" onclick="openSharePanel('${s.id}')">Share</button>
        ${mp4}
      </div>
    </div>`;
  }).join('');
}

// ── Start stream ──────────────────────────────────────────────────────────────
document.getElementById('btn-start').addEventListener('click', async () => {
  const name = document.getElementById('stream-name-input').value.trim();
  const res = await fetch('/api/admin/streams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) { alert('Failed to create stream'); return; }
  const { id, wsUrl } = await res.json();
  activeStreamId = id;
  document.getElementById('active-name').textContent = name || id;
  document.getElementById('active-panel').classList.remove('hidden');
  loadShareList(id);
  await loadStreams();
  // Note: actual ingest happens from the Android streamer app
  // This just creates the stream record; the streamer PWA connects the WebSocket
});

// ── Stop stream ───────────────────────────────────────────────────────────────
document.getElementById('btn-stop').addEventListener('click', async () => {
  if (!activeStreamId) return;
  if (!confirm('Stop the stream?')) return;
  await fetch(`/api/admin/streams/${activeStreamId}/end`, { method: 'POST' });
  document.getElementById('active-panel').classList.add('hidden');
  activeStreamId = null;
  await loadStreams();
});

// ── Share links ───────────────────────────────────────────────────────────────
async function openSharePanel(streamId) {
  activeStreamId = streamId;
  document.getElementById('active-panel').classList.remove('hidden');
  const s = await fetch(`/api/admin/streams/${streamId}`).then(r => r.json());
  document.getElementById('active-name').textContent = s.name;
  loadShareList(streamId);
}

async function loadShareList(streamId) {
  const s = await fetch(`/api/admin/streams/${streamId}`).then(r => r.json());
  const list = document.getElementById('share-list');
  if (!s.links || !s.links.length) { list.innerHTML = '<li class="muted">No links yet</li>'; return; }
  list.innerHTML = s.links.map(l => `
    <li class="share-item">
      <span class="share-slug">/s/${esc(l.slug)}</span>
      <span class="muted">${l.password_hash ? '🔒' : '🔓'}</span>
      <button class="btn btn-sm" onclick="copyUrl('/s/${esc(l.slug)}')">Copy</button>
      <button class="btn btn-sm btn-danger" onclick="deleteLink('${l.id}', '${streamId}')">Delete</button>
    </li>
  `).join('');
}

document.getElementById('btn-create-share').addEventListener('click', async () => {
  if (!activeStreamId) return;
  const slug = document.getElementById('share-slug-input').value.trim();
  const password = document.getElementById('share-password-input').value;

  const res = await fetch(`/api/admin/streams/${activeStreamId}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: slug || undefined, password: password || undefined }),
  });

  if (!res.ok) {
    const err = await res.json();
    alert(err.error || 'Failed to create link');
    return;
  }

  const { url } = await res.json();
  showShareModal(url);
  document.getElementById('share-slug-input').value = '';
  document.getElementById('share-password-input').value = '';
  loadShareList(activeStreamId);
});

async function deleteLink(linkId, streamId) {
  if (!confirm('Delete this share link?')) return;
  await fetch(`/api/admin/share/${linkId}`, { method: 'DELETE' });
  loadShareList(streamId);
}

// ── Share modal ───────────────────────────────────────────────────────────────
function showShareModal(path) {
  const url = `${location.origin}${path}`;
  document.getElementById('share-url-display').value = url;
  document.getElementById('share-modal').classList.remove('hidden');
}

document.getElementById('btn-copy-url').addEventListener('click', () => {
  const inp = document.getElementById('share-url-display');
  inp.select();
  navigator.clipboard.writeText(inp.value).catch(() => document.execCommand('copy'));
});

document.getElementById('btn-modal-close').addEventListener('click', () => {
  document.getElementById('share-modal').classList.add('hidden');
});

function copyUrl(path) {
  navigator.clipboard.writeText(`${location.origin}${path}`).catch(() => {});
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
