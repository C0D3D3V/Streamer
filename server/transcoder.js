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
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=black:s=64x64:d=0.1',
    '-vf', 'format=nv12',
    '-c:v', 'h264_qsv', '-frames:v', '1',
    '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0;
}

async function detectEncoder() {
  const requested = config.encoder;

  if (requested !== 'auto') {
    console.log(`[transcoder] Using configured encoder: ${requested}`);
    return requested;
  }

  // Try QSV first (Intel Quick Sync — lowest CPU usage)
  if (probeEncoder('h264_qsv') && probeQsv()) {
    console.log('[transcoder] Auto-detected: h264_qsv (Intel Quick Sync)');
    return 'qsv';
  }

  // Try VAAPI (VA-API on Linux — also hardware, most Intel iGPUs support this)
  if (probeEncoder('h264_vaapi') && probeVaapi(config.vaapiDevice)) {
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

function globalInputArgs() {
  if (resolvedEncoder === 'vaapi') {
    return ['-vaapi_device', config.vaapiDevice];
  }
  return [];
}

// Build per-resolution output args for one resolution
function buildOutputArgs(r, hlsDir) {
  const playlist    = path.join(hlsDir, 'playlist.m3u8');
  const segPattern  = path.join(hlsDir, 'seg%05d.ts');
  const bufsize     = `${parseInt(r.videoBitrate) * 2}k`;

  const hlsArgs = [
    '-f', 'hls',
    '-hls_time', String(config.hls.segmentDuration),
    '-hls_list_size', String(config.hls.listSize),
    '-hls_flags', 'append_list+delete_segments+omit_endlist',
    '-hls_segment_type', config.hls.segmentType,
    '-hls_segment_filename', segPattern,
    playlist,
  ];

  const audioArgs = [
    '-c:a', 'aac', '-b:a', r.audioBitrate, '-ar', '44100',
  ];

  // Scale filter — same for all encoders, applied in software before upload
  const scaleFilter = `scale=${r.width}:${r.height}:force_original_aspect_ratio=decrease,pad=${r.width}:${r.height}:(ow-iw)/2:(oh-ih)/2`;

  if (resolvedEncoder === 'qsv') {
    return [
      '-map', '0:v:0', '-map', '0:a:0',
      '-vf', `${scaleFilter},format=nv12`,
      '-c:v', 'h264_qsv',
      '-preset', 'veryfast',
      '-b:v', r.videoBitrate, '-maxrate', r.videoBitrate, '-bufsize', bufsize,
      '-look_ahead', '0',      // disable lookahead for low-latency live
      '-async_depth', '1',     // reduce encoder pipeline depth
      ...audioArgs,
      ...hlsArgs,
    ];
  }

  if (resolvedEncoder === 'vaapi') {
    // VAAPI H264 requires dimensions aligned to multiples of 16
    const snap16 = n => Math.floor(n / 16) * 16;
    const vw = snap16(r.width);
    const vh = snap16(r.height);
    const vaapiScale = `scale=${vw}:${vh}:force_original_aspect_ratio=decrease,pad=${vw}:${vh}:(ow-iw)/2:(oh-ih)/2`;
    return [
      '-map', '0:v:0', '-map', '0:a:0',
      '-vf', `${vaapiScale},format=nv12,hwupload=extra_hw_frames=64`,
      '-c:v', 'h264_vaapi',
      '-b:v', r.videoBitrate, '-maxrate', r.videoBitrate, '-bufsize', bufsize,
      ...audioArgs,
      ...hlsArgs,
    ];
  }

  // libx264 (software) — use all available CPU threads
  return [
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-threads', '0',
    '-b:v', r.videoBitrate, '-maxrate', r.videoBitrate, '-bufsize', bufsize,
    '-vf', scaleFilter,
    ...audioArgs,
    ...hlsArgs,
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
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${r.width}x${r.height},NAME="${r.name}"`);
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

  const outputArgs = config.resolutions.flatMap(r =>
    buildOutputArgs(r, getStreamHlsDir(streamId, r.name))
  );

  const ffmpegArgs = [
    '-loglevel', 'warning',
    ...globalInputArgs(),
    '-i', 'pipe:0',
    ...outputArgs,
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
