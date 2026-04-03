'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// Active FFmpeg processes keyed by streamId
const activeProcesses = new Map();

// Resolved encoder after auto-detection
let resolvedEncoder = null;

// ── Encoder detection ─────────────────────────────────────────────────────────

function probeEncoder(name) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  return result.stdout && result.stdout.includes(` ${name} `);
}

function probeVaapi(device) {
  // Try a quick 1-frame encode to validate VAAPI works on this device
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-vaapi_device', device,
    '-f', 'lavfi', '-i', 'color=black:s=64x64:d=0.1',
    '-vf', 'format=nv12,hwupload',
    '-c:v', 'h264_vaapi', '-frames:v', '1',
    '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0;
}

function probeQsv() {
  // Must init the QSV device explicitly — same as we do during real transcoding
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-init_hw_device', 'qsv=hw',
    '-f', 'lavfi', '-i', 'color=black:s=64x64:d=0.1',
    '-vf', 'format=nv12',
    '-c:v', 'h264_qsv', '-frames:v', '1',
    '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) {
    console.warn('[transcoder] QSV probe failed:', (result.stderr || '').trim().split('\n').pop());
  }
  return result.status === 0;
}

async function detectEncoder() {
  const requested = config.encoder;

  if (requested !== 'auto') {
    console.log(`[transcoder] Using configured encoder: ${requested}`);
    return requested;
  }

  // Try QSV first (Intel Quick Sync — lowest CPU usage)
  const hasQsvEncoder = probeEncoder('h264_qsv');
  console.log(`[transcoder] h264_qsv in ffmpeg: ${hasQsvEncoder}`);
  if (hasQsvEncoder && probeQsv()) {
    console.log('[transcoder] Auto-detected: h264_qsv (Intel Quick Sync)');
    return 'qsv';
  }

  // Try VAAPI (VA-API on Linux — also hardware, most Intel iGPUs support this)
  const hasVaapiEncoder = probeEncoder('h264_vaapi');
  console.log(`[transcoder] h264_vaapi in ffmpeg: ${hasVaapiEncoder}`);
  if (hasVaapiEncoder && probeVaapi(config.vaapiDevice)) {
    console.log(`[transcoder] Auto-detected: h264_vaapi (${config.vaapiDevice})`);
    return 'vaapi';
  }

  console.log('[transcoder] Falling back to libx264 (software)');
  return 'libx264';
}

async function init() {
  resolvedEncoder = await detectEncoder();
}

// ── FFmpeg arg builders ────────────────────────────────────────────────────────

function hlsOutputArgs(r, hlsDir) {
  const playlist   = path.join(hlsDir, 'playlist.m3u8');
  const segPattern = path.join(hlsDir, 'seg%05d.ts');
  return [
    '-f', 'hls',
    '-hls_time', String(config.hls.segmentDuration),
    '-hls_list_size', String(config.hls.listSize),
    '-hls_flags', 'append_list+delete_segments+omit_endlist',
    '-hls_segment_type', config.hls.segmentType,
    '-hls_segment_filename', segPattern,
    playlist,
  ];
}

// Build full FFmpeg args for VAAPI using filter_complex:
// single hwupload → split N ways → scale_vaapi per output.
// This avoids the surface exhaustion that happens with N separate hwupload instances.
// Scale uses the long edge as the constraint so both landscape and portrait input work.
function buildVaapiArgs(streamId) {
  const snap16 = n => Math.floor(n / 16) * 16;
  const n = config.resolutions.length;

  const splitTags = config.resolutions.map((_, i) => `[vsplit${i}]`).join('');
  const fcParts = [`[0:v]format=nv12,hwupload=extra_hw_frames=64,split=${n}${splitTags}`];
  for (let i = 0; i < n; i++) {
    const r = config.resolutions[i];
    const long = snap16(Math.max(r.width, r.height));
    // if(gte(iw,ih), ...) = landscape branch; else portrait branch
    // -16 tells scale_vaapi to round the auto-computed side to a multiple of 16
    fcParts.push(`[vsplit${i}]scale_vaapi=w='if(gte(iw,ih),${long},-16)':h='if(gte(iw,ih),-16,${long})'[vout${i}]`);
  }

  const outputArgs = config.resolutions.flatMap((r, i) => {
    const hlsDir = getStreamHlsDir(streamId, r.name);
    const bufsize = `${parseInt(r.videoBitrate) * 2}k`;
    return [
      '-map', `[vout${i}]`, '-map', '0:a:0',
      '-c:v', 'h264_vaapi',
      '-b:v', r.videoBitrate, '-maxrate', r.videoBitrate, '-bufsize', bufsize,
      '-c:a', 'aac', '-b:a', r.audioBitrate, '-ar', '44100',
      ...hlsOutputArgs(r, hlsDir),
    ];
  });

  return [
    '-loglevel', 'warning',
    '-vaapi_device', config.vaapiDevice,
    '-i', 'pipe:0',
    '-filter_complex', fcParts.join(';'),
    ...outputArgs,
  ];
}

// Build per-resolution output args for software encoders (libx264, qsv)
function buildOutputArgs(r, hlsDir) {
  const bufsize     = `${parseInt(r.videoBitrate) * 2}k`;
  // Scale to the long edge; -2 keeps the other side even and aspect-correct.
  // Works for both landscape and portrait without forced black-bar padding.
  const long = Math.max(r.width, r.height);
  const scaleFilter = `scale=w='if(gte(iw,ih),${long},-2)':h='if(gte(iw,ih),-2,${long})'`;
  const audioArgs   = ['-c:a', 'aac', '-b:a', r.audioBitrate, '-ar', '44100'];

  if (resolvedEncoder === 'qsv') {
    return [
      '-map', '0:v:0', '-map', '0:a:0',
      '-vf', `${scaleFilter},format=nv12`,
      '-c:v', 'h264_qsv',
      '-preset', 'veryfast',
      '-b:v', r.videoBitrate, '-maxrate', r.videoBitrate, '-bufsize', bufsize,
      '-look_ahead', '0',
      '-async_depth', '1',
      ...audioArgs,
      ...hlsOutputArgs(r, hlsDir),
    ];
  }

  // libx264
  return [
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-threads', '0',
    '-b:v', r.videoBitrate, '-maxrate', r.videoBitrate, '-bufsize', bufsize,
    '-vf', scaleFilter,
    ...audioArgs,
    ...hlsOutputArgs(r, hlsDir),
  ];
}

// ── HLS helpers ───────────────────────────────────────────────────────────────

function getStreamHlsDir(streamId, res) {
  return path.join(config.streamsDir, streamId, 'hls', res);
}

function getPlaylistPath(streamId, res) {
  return path.join(getStreamHlsDir(streamId, res), 'playlist.m3u8');
}

function getMasterPlaylistPath(streamId) {
  return path.join(config.streamsDir, streamId, 'hls', 'master.m3u8');
}

function buildMasterPlaylist() {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', ''];
  for (const r of config.resolutions) {
    const bw = parseInt(r.videoBitrate) * 1000 + parseInt(r.audioBitrate) * 1000;
    // RESOLUTION omitted: value depends on stream orientation (landscape vs portrait)
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},NAME="${r.name}"`);
    lines.push(`${r.name}/playlist.m3u8`);
  }
  return lines.join('\n');
}

// ── Transcode ─────────────────────────────────────────────────────────────────

function startTranscoding(streamId, inputStream) {
  const hlsBase = path.join(config.streamsDir, streamId, 'hls');

  for (const r of config.resolutions) {
    fs.mkdirSync(path.join(hlsBase, r.name), { recursive: true });
  }
  fs.writeFileSync(getMasterPlaylistPath(streamId), buildMasterPlaylist());

  const ffmpegArgs = resolvedEncoder === 'vaapi'
    ? buildVaapiArgs(streamId)
    : [
        '-loglevel', 'warning',
        ...(resolvedEncoder === 'qsv' ? ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw'] : []),
        '-i', 'pipe:0',
        ...config.resolutions.flatMap(r => buildOutputArgs(r, getStreamHlsDir(streamId, r.name))),
      ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'inherit', 'inherit'] });

  ffmpeg.on('error', (err) => {
    console.error(`[transcoder:${streamId}] FFmpeg error:`, err.message);
  });

  ffmpeg.on('exit', (code, signal) => {
    console.log(`[transcoder:${streamId}] FFmpeg exited code=${code} signal=${signal} encoder=${resolvedEncoder}`);
    activeProcesses.delete(streamId);
  });

  inputStream.pipe(ffmpeg.stdin);
  inputStream.on('error', () => ffmpeg.stdin.destroy());
  ffmpeg.stdin.on('error', () => {});

  activeProcesses.set(streamId, ffmpeg);
  console.log(`[transcoder:${streamId}] Started FFmpeg encoder=${resolvedEncoder} outputs=${config.resolutions.length}`);
  return ffmpeg;
}

function stopTranscoding(streamId) {
  const proc = activeProcesses.get(streamId);
  if (!proc) return;
  proc.stdin.end();
  setTimeout(() => {
    if (!proc.killed) proc.kill('SIGTERM');
  }, 5000);
}

function finalizeHls(streamId) {
  for (const r of config.resolutions) {
    const playlist = getPlaylistPath(streamId, r.name);
    if (!fs.existsSync(playlist)) continue;
    let content = fs.readFileSync(playlist, 'utf8');
    if (!content.includes('#EXT-X-ENDLIST')) {
      content = content.trimEnd() + '\n#EXT-X-ENDLIST\n';
      fs.writeFileSync(playlist, content);
    }
  }
  console.log(`[transcoder:${streamId}] HLS playlists finalized as VOD`);
}

function isActive(streamId) {
  return activeProcesses.has(streamId);
}

function getResolvedEncoder() {
  return resolvedEncoder;
}

module.exports = {
  init,
  startTranscoding, stopTranscoding, finalizeHls,
  getPlaylistPath, getMasterPlaylistPath, getStreamHlsDir,
  isActive, getResolvedEncoder,
};
