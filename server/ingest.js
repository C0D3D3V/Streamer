'use strict';

const { PassThrough } = require('stream');
const transcoder = require('./transcoder');
const db = require('./db');

// Active ingest streams keyed by streamId
const activeStreams = new Map();

function handleIngestSocket(ws, streamId) {
  if (activeStreams.has(streamId)) {
    ws.close(4000, 'Stream already active');
    return;
  }

  console.log(`[ingest:${streamId}] WebSocket connected`);

  const passThrough = new PassThrough();
  activeStreams.set(streamId, passThrough);

  transcoder.startTranscoding(streamId, passThrough, () => {
    // Hardware encoder failed — close the socket so the client reconnects immediately
    // with the now-downgraded encoder. The 3-second finalization timer in ws.on('close')
    // will be skipped if the client reconnects before it fires.
    if (ws.readyState === ws.OPEN) ws.close(4001, 'Encoder failure, please reconnect');
  });

  ws.on('message', (data) => {
    if (!passThrough.destroyed) {
      passThrough.write(data);
    }
  });

  ws.on('close', () => {
    console.log(`[ingest:${streamId}] WebSocket closed`);
    passThrough.end();
    activeStreams.delete(streamId);
    transcoder.stopTranscoding(streamId);

    // Finalize after FFmpeg has had time to flush.
    // Skip if a new connection for the same stream has already started (orientation reconnect).
    setTimeout(() => {
      if (activeStreams.has(streamId)) return;
      transcoder.finalizeHls(streamId);
      db.endStream(streamId);
      require('./converter').queueConversion(streamId);
    }, 3000);
  });

  ws.on('error', (err) => {
    console.error(`[ingest:${streamId}] WS error:`, err.message);
    passThrough.destroy(err);
    activeStreams.delete(streamId);
  });
}

function isStreaming(streamId) {
  return activeStreams.has(streamId);
}

module.exports = { handleIngestSocket, isStreaming };
