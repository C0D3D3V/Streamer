'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const db = require('./db');

const queue = [];
let running = false;

function queueConversion(streamId) {
  queue.push(streamId);
  console.log(`[converter] Queued MP4 conversion for ${streamId}`);
  processNext();
}

function processNext() {
  if (running || queue.length === 0) return;
  const streamId = queue.shift();
  running = true;
  convert(streamId).finally(() => {
    running = false;
    processNext();
  });
}

async function convert(streamId) {
  const stream = db.getStream(streamId);
  if (!stream) return;

  // Use 1080p playlist as source (highest quality)
  const playlist = path.join(config.streamsDir, streamId, 'hls', '1080p', 'playlist.m3u8');
  if (!fs.existsSync(playlist)) {
    console.warn(`[converter:${streamId}] Playlist not found, skipping`);
    return;
  }

  const outPath = path.join(config.streamsDir, streamId, 'recording.mp4');
  db.setMp4Status(streamId, 'converting');
  console.log(`[converter:${streamId}] Starting HLS → MP4`);

  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', [
      '-loglevel', 'warning',
      '-allowed_extensions', 'ALL',
      '-i', playlist,
      '-c', 'copy',
      '-movflags', '+faststart',
      outPath,
    ]);

    ffmpeg.on('exit', (code) => {
      if (code === 0) {
        db.setMp4Status(streamId, 'done', outPath);
        console.log(`[converter:${streamId}] MP4 ready: ${outPath}`);
      } else {
        db.setMp4Status(streamId, 'error');
        console.error(`[converter:${streamId}] FFmpeg exited with code ${code}`);
      }
      resolve();
    });

    ffmpeg.on('error', (err) => {
      db.setMp4Status(streamId, 'error');
      console.error(`[converter:${streamId}] Spawn error:`, err.message);
      resolve();
    });
  });
}

// Resume any pending conversions on startup
function resumePending() {
  const streams = db.listStreams();
  for (const s of streams) {
    if (s.mp4_status === 'converting' || s.mp4_status === 'pending') {
      console.log(`[converter] Resuming conversion for ${s.id}`);
      queueConversion(s.id);
    }
  }
}

module.exports = { queueConversion, resumePending };
