'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

let db;

function init() {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS streams (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      mp4_status  TEXT NOT NULL DEFAULT 'none',
      mp4_path    TEXT
    );

    CREATE TABLE IF NOT EXISTS share_links (
      id            TEXT PRIMARY KEY,
      stream_id     TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
      slug          TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      created_by    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_share_links_slug ON share_links(slug);
    CREATE INDEX IF NOT EXISTS idx_share_links_stream ON share_links(stream_id);
  `);

  return db;
}

function get() {
  if (!db) throw new Error('DB not initialised');
  return db;
}

// streams
function createStream(id, name) {
  return get().prepare(
    'INSERT INTO streams (id, name, started_at) VALUES (?, ?, ?)'
  ).run(id, name, Date.now());
}

function endStream(id) {
  return get().prepare(
    'UPDATE streams SET ended_at = ? WHERE id = ?'
  ).run(Date.now(), id);
}

function getStream(id) {
  return get().prepare('SELECT * FROM streams WHERE id = ?').get(id);
}

function listStreams() {
  return get().prepare('SELECT * FROM streams ORDER BY started_at DESC').all();
}

function setMp4Status(streamId, status, mp4Path) {
  if (mp4Path !== undefined) {
    return get().prepare(
      'UPDATE streams SET mp4_status = ?, mp4_path = ? WHERE id = ?'
    ).run(status, mp4Path, streamId);
  }
  return get().prepare(
    'UPDATE streams SET mp4_status = ? WHERE id = ?'
  ).run(status, streamId);
}

// share links
function createShareLink({ id, streamId, slug, passwordHash, createdBy, expiresAt }) {
  return get().prepare(
    'INSERT INTO share_links (id, stream_id, slug, password_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, streamId, slug, passwordHash || null, createdBy, Date.now(), expiresAt || null);
}

function getShareBySlug(slug) {
  return get().prepare(
    'SELECT sl.*, s.name as stream_name, s.ended_at, s.mp4_status, s.mp4_path FROM share_links sl JOIN streams s ON s.id = sl.stream_id WHERE sl.slug = ?'
  ).get(slug);
}

function getSharesByStream(streamId) {
  return get().prepare('SELECT * FROM share_links WHERE stream_id = ?').all(streamId);
}

function deleteShareLink(id) {
  return get().prepare('DELETE FROM share_links WHERE id = ?').run(id);
}

function slugExists(slug) {
  return !!get().prepare('SELECT 1 FROM share_links WHERE slug = ?').get(slug);
}

module.exports = {
  init, get,
  createStream, endStream, getStream, listStreams, setMp4Status,
  createShareLink, getShareBySlug, getSharesByStream, deleteShareLink, slugExists,
};
