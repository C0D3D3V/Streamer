'use strict';

const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  dataDir: DATA_DIR,
  streamsDir: path.join(DATA_DIR, 'streams'),
  dbPath: path.join(DATA_DIR, 'db.sqlite'),

  session: {
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 },
    store: null, // set in index.js after DB init
  },

  oidc: {
    issuer: process.env.OIDC_ISSUER || '',
    clientId: process.env.OIDC_CLIENT_ID || '',
    clientSecret: process.env.OIDC_CLIENT_SECRET || '',
    redirectUri: process.env.OIDC_REDIRECT_URI || '',
  },

  resolutions: [
    { name: '1080p', width: 1920, height: 1080, videoBitrate: '4500k', audioBitrate: '192k' },
    { name: '720p',  width: 1280, height: 720,  videoBitrate: '2500k', audioBitrate: '128k' },
    { name: '480p',  width: 854,  height: 480,  videoBitrate: '1200k', audioBitrate: '96k'  },
    { name: '320p',  width: 568,  height: 320,  videoBitrate: '600k',  audioBitrate: '64k'  },
  ],

  hls: {
    segmentDuration: 2,      // seconds per segment
    listSize: 0,             // 0 = keep all segments (full DVR)
    segmentType: 'mpegts',
  },

  // Hardware acceleration
  // Options: 'auto' (detect at startup), 'qsv', 'vaapi', 'libx264'
  encoder: process.env.FFMPEG_ENCODER || 'auto',
  vaapiDevice: process.env.VAAPI_DEVICE || '/dev/dri/renderD128',
};
