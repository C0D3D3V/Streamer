'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const session = require('express-session');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const ingest = require('./ingest');
const transcoder = require('./transcoder');
const converter = require('./converter');

const { customAlphabet } = require('nanoid');
const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8);

// ── Init ─────────────────────────────────────────────────────────────────────
db.init();
fs.mkdirSync(config.streamsDir, { recursive: true });

const app = express();
const server = http.createServer(app);

// ── Session ──────────────────────────────────────────────────────────────────
const SQLiteStore = require('connect-sqlite3')(session);
const sessionMiddleware = session({
  ...config.session,
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.dirname(config.dbPath) }),
});
app.use(sessionMiddleware);

// ── Body parsers ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Static public files ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Auth routes ───────────────────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const url = auth.buildAuthUrl(req);
  if (!url) return res.status(503).send('OIDC not configured');
  req.session.save(() => res.redirect(url));
});

app.get('/auth/callback', async (req, res) => {
  try {
    const claims = await auth.handleCallback(req);
    req.session.user = {
      sub: claims.sub,
      name: claims.name || claims.preferred_username || claims.email || claims.sub,
      email: claims.email,
    };
    const returnTo = req.session.returnTo || '/admin/';
    delete req.session.returnTo;
    res.redirect(returnTo);
  } catch (err) {
    console.error('[auth] Callback error:', err.message);
    res.status(500).send('Authentication failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/auth/me', (req, res) => {
  if (req.session.user) return res.json({ user: req.session.user });
  res.status(401).json({ error: 'Not authenticated' });
});

// ── Admin API (requires login) ─────────────────────────────────────────────
const adminRouter = express.Router();
adminRouter.use(auth.requireAdmin);

// Server info
adminRouter.get('/info', (req, res) => {
  res.json({ encoder: transcoder.getResolvedEncoder() });
});

// List streams
adminRouter.get('/streams', (req, res) => {
  res.json(db.listStreams());
});

// Start a new stream — returns streamId and WebSocket URL
adminRouter.post('/streams', (req, res) => {
  const name = (req.body.name || '').trim() || `Stream ${new Date().toLocaleString()}`;
  const id = crypto.randomUUID();
  fs.mkdirSync(path.join(config.streamsDir, id), { recursive: true });
  db.createStream(id, name);
  res.json({ id, name, wsUrl: `/ingest/${id}` });
});

// End a stream manually
adminRouter.post('/streams/:id/end', (req, res) => {
  const { id } = req.params;
  if (ingest.isStreaming(id)) {
    // The WS close handler will call endStream + queueConversion
    transcoder.stopTranscoding(id);
  } else {
    db.endStream(id);
    converter.queueConversion(id);
  }
  res.json({ ok: true });
});

// Get stream detail
adminRouter.get('/streams/:id', (req, res) => {
  const stream = db.getStream(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Not found' });
  const links = db.getSharesByStream(req.params.id);
  res.json({ ...stream, links });
});

// Create share link
adminRouter.post('/streams/:id/share', (req, res) => {
  const stream = db.getStream(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Not found' });

  let { slug, password, expiresIn } = req.body;

  // Validate / generate slug
  if (slug) {
    slug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!slug) return res.status(400).json({ error: 'Invalid slug' });
    if (db.slugExists(slug)) return res.status(409).json({ error: 'Slug already taken' });
  } else {
    do { slug = nanoid(); } while (db.slugExists(slug));
  }

  const id = crypto.randomUUID();
  const passwordHash = password ? auth.hashPassword(password) : null;
  const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : null;

  db.createShareLink({ id, streamId: req.params.id, slug, passwordHash, createdBy: req.session.user.sub, expiresAt });
  res.json({ id, slug, url: `/s/${slug}` });
});

// Delete share link
adminRouter.delete('/share/:id', (req, res) => {
  db.deleteShareLink(req.params.id);
  res.json({ ok: true });
});

// MP4 status (poll endpoint)
adminRouter.get('/streams/:id/mp4status', (req, res) => {
  const s = db.getStream(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ status: s.mp4_status, mp4Path: s.mp4_path });
});

app.use('/api/admin', adminRouter);

// ── Public stream status (for shared page) ───────────────────────────────────
app.get('/api/share/:slug/status', (req, res) => {
  const link = db.getShareBySlug(req.params.slug);
  if (!link) return res.status(404).json({ error: 'Not found' });

  // Check share access
  const granted = req.session.shareAccess || {};
  const isAdmin = !!(req.session && req.session.user);
  const hasAccess = isAdmin || !link.password_hash || !!granted[req.params.slug];

  if (!hasAccess) return res.status(403).json({ error: 'password_required' });

  res.json({
    streamId: link.stream_id,
    streamName: link.stream_name,
    isLive: ingest.isStreaming(link.stream_id),
    endedAt: link.ended_at,
    mp4Status: link.mp4_status,
  });
});

// ── Share link unlock ────────────────────────────────────────────────────────
app.get('/s/:slug/unlock', (req, res) => {
  const link = db.getShareBySlug(req.params.slug);
  if (!link) return res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
  res.sendFile(path.join(__dirname, '..', 'public', 'shared', 'unlock.html'));
});

app.post('/s/:slug/unlock', (req, res) => {
  const link = db.getShareBySlug(req.params.slug);
  if (!link) return res.status(404).json({ error: 'Not found' });
  if (!link.password_hash) {
    // No password, just redirect
    return res.json({ ok: true });
  }
  if (!auth.verifyPassword(req.body.password || '', link.password_hash)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  if (!req.session.shareAccess) req.session.shareAccess = {};
  req.session.shareAccess[req.params.slug] = true;
  res.json({ ok: true });
});

// ── Share link viewer ─────────────────────────────────────────────────────────
app.get('/s/:slug', auth.requireShare, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'shared', 'watch.html'));
});

// ── HLS file serving ──────────────────────────────────────────────────────────
// Shared HLS: validate access via slug query param
app.get('/hls/share/:slug/*', (req, res, next) => {
  const link = db.getShareBySlug(req.params.slug);
  if (!link) return res.status(404).end();

  const isAdmin = !!(req.session && req.session.user);
  const granted = req.session.shareAccess || {};
  if (!isAdmin && link.password_hash && !granted[req.params.slug]) {
    return res.status(403).end();
  }

  const relativePath = req.params[0];
  const filePath = path.join(config.streamsDir, link.stream_id, 'hls', relativePath);
  res.sendFile(filePath, (err) => {
    if (err && err.code !== 'ENOENT') next(err);
    else if (err) res.status(404).end();
  });
});

// Admin HLS access (no slug needed)
app.get('/hls/:streamId/*', auth.requireAdmin, (req, res) => {
  const filePath = path.join(config.streamsDir, req.params.streamId, 'hls', req.params[0]);
  res.sendFile(filePath, (err) => {
    if (err) res.status(404).end();
  });
});

// ── MP4 download ──────────────────────────────────────────────────────────────
function serveDownload(streamId, req, res) {
  const stream = db.getStream(streamId);
  if (!stream || stream.mp4_status !== 'done' || !stream.mp4_path) {
    return res.status(404).json({ error: 'MP4 not ready' });
  }
  const filename = `${stream.name.replace(/[^a-z0-9]/gi, '_')}.mp4`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.sendFile(stream.mp4_path);
}

app.get('/download/share/:slug', auth.requireShare, (req, res) => {
  serveDownload(req.shareLink.stream_id, req, res);
});

app.get('/download/:streamId', auth.requireAdmin, (req, res) => {
  serveDownload(req.params.streamId, req, res);
});

// MP4 status for shared page (access already validated by requireShare)
app.get('/api/share/:slug/mp4status', auth.requireShare, (req, res) => {
  const stream = db.getStream(req.shareLink.stream_id);
  res.json({ status: stream.mp4_status });
});

// ── WebSocket: ingest ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // Parse session for upgrade requests
  sessionMiddleware(req, {}, () => {
    const match = req.url.match(/^\/ingest\/([a-f0-9-]{36})$/);
    if (!match) { socket.destroy(); return; }
    const streamId = match[1];

    // Must be authenticated admin to ingest
    if (!req.session || !req.session.user) { socket.destroy(); return; }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ingest.handleIngestSocket(ws, streamId);
    });
  });
});

// ── Admin SPA catch-all ───────────────────────────────────────────────────────
app.get('/admin/*', auth.requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
Promise.all([auth.initOidc(), transcoder.init()]).then(() => {
  converter.resumePending();
  server.listen(config.port, () => {
    console.log(`[server] Listening on port ${config.port} encoder=${transcoder.getResolvedEncoder()}`);
  });
});
