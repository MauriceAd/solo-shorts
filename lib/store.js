/**
 * Storage layer for solo shorts.
 *
 * One interface, two implementations:
 *  - R2D1Store: videos in Cloudflare R2, metadata in Cloudflare D1
 *    (used when all R2, CF and D1 env vars are set).
 *  - MemoryStore: everything in memory, for local testing WITHOUT any
 *    credentials. Data does not persist across restarts. Never used when
 *    the R2/D1 env vars are present.
 *
 * Video row shape returned everywhere:
 *   { id, title, r2_key, width, height, duration, views,
 *     likes, liked, comments, created_at, stream_url }
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createD1Client } = require('./d1');
const { createR2Client } = require('./r2');

const VIEW_DEDUPE_MS = 10 * 60 * 1000; // one counted view per device per video per 10 min

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS videos (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL,
     r2_key TEXT NOT NULL,
     width INTEGER,
     height INTEGER,
     duration REAL,
     views INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS likes (
     video_id INTEGER NOT NULL,
     device_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (video_id, device_id)
   )`,
  `CREATE TABLE IF NOT EXISTS comments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     video_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     text TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS video_views (
     video_id INTEGER NOT NULL,
     device_id TEXT NOT NULL,
     viewed_at INTEGER NOT NULL,
     PRIMARY KEY (video_id, device_id)
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

function tmpFile(suffix) {
  return path.join(os.tmpdir(), `ss-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${suffix}`);
}

// ---------------------------------------------------------------------------
// Real store: R2 + D1
// ---------------------------------------------------------------------------
class R2D1Store {
  constructor(env) {
    this.mode = 'r2-d1';
    this.d1 = createD1Client({
      accountId: env.CF_ACCOUNT_ID,
      databaseId: env.D1_DATABASE_ID,
      apiToken: env.CF_API_TOKEN,
    });
    this.r2 = createR2Client({
      endpoint: env.R2_ENDPOINT,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET,
      publicBaseUrl: env.R2_PUBLIC_BASE_URL,
    });
  }

  async init() {
    for (const sql of SCHEMA) await this.d1.query(sql);
  }

  streamUrl(video) {
    return this.r2.publicUrl(video.r2_key); // null when no public base URL set
  }

  async listVideos(deviceId) {
    const { rows } = await this.d1.query(
      `SELECT v.*,
         (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id) AS likes,
         (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id) AS comments,
         EXISTS(SELECT 1 FROM likes l2 WHERE l2.video_id = v.id AND l2.device_id = ?) AS liked
       FROM videos v ORDER BY v.created_at DESC, v.id DESC`,
      [deviceId || '']
    );
    return rows.map((r) => this._shape(r));
  }

  async getVideo(id) {
    const { rows } = await this.d1.query('SELECT * FROM videos WHERE id = ?', [id]);
    if (!rows.length) return null;
    const counts = await this.d1.query(
      `SELECT (SELECT COUNT(*) FROM likes WHERE video_id = ?) AS likes,
              (SELECT COUNT(*) FROM comments WHERE video_id = ?) AS comments`,
      [id, id]
    );
    return this._shape({ ...rows[0], ...counts.rows[0], liked: false });
  }

  async createVideo({ title, r2Key, width, height, duration }) {
    const { meta } = await this.d1.query(
      'INSERT INTO videos (title, r2_key, width, height, duration, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [title, r2Key, width, height, duration, Date.now()]
    );
    const row = await this.getVideo(meta.last_row_id);
    return row;
  }

  async updateVideoTitle(id, title) {
    await this.d1.query('UPDATE videos SET title = ? WHERE id = ?', [title, id]);
    return this.getVideo(id);
  }

  async deleteVideo(id) {
    const video = await this.getVideo(id);
    if (!video) return null;
    await this.d1.query('DELETE FROM likes WHERE video_id = ?', [id]);
    await this.d1.query('DELETE FROM comments WHERE video_id = ?', [id]);
    await this.d1.query('DELETE FROM video_views WHERE video_id = ?', [id]);
    await this.d1.query('DELETE FROM videos WHERE id = ?', [id]);
    return video;
  }

  async toggleLike(videoId, deviceId, liked) {
    if (liked) {
      await this.d1.query(
        'INSERT OR IGNORE INTO likes (video_id, device_id, created_at) VALUES (?, ?, ?)',
        [videoId, deviceId, Date.now()]
      );
    } else {
      await this.d1.query('DELETE FROM likes WHERE video_id = ? AND device_id = ?', [videoId, deviceId]);
    }
    const { rows } = await this.d1.query('SELECT COUNT(*) AS n FROM likes WHERE video_id = ?', [videoId]);
    return { likes: rows[0].n, liked };
  }

  async listComments(videoId) {
    const { rows } = await this.d1.query(
      'SELECT * FROM comments WHERE video_id = ? ORDER BY created_at ASC, id ASC', [videoId]
    );
    return rows;
  }

  async addComment(videoId, name, text) {
    const { meta } = await this.d1.query(
      'INSERT INTO comments (video_id, name, text, created_at) VALUES (?, ?, ?, ?)',
      [videoId, name, text, Date.now()]
    );
    const { rows } = await this.d1.query('SELECT * FROM comments WHERE id = ?', [meta.last_row_id]);
    return rows[0];
  }

  async deleteComment(id) {
    const { meta } = await this.d1.query('DELETE FROM comments WHERE id = ?', [id]);
    return meta.changes > 0;
  }

  async countView(videoId, deviceId) {
    const now = Date.now();
    let counted = false;
    if (deviceId) {
      const { rows } = await this.d1.query(
        'SELECT viewed_at FROM video_views WHERE video_id = ? AND device_id = ?', [videoId, deviceId]
      );
      if (!rows.length || now - rows[0].viewed_at > VIEW_DEDUPE_MS) {
        await this.d1.query(
          `INSERT INTO video_views (video_id, device_id, viewed_at) VALUES (?, ?, ?)
           ON CONFLICT(video_id, device_id) DO UPDATE SET viewed_at = excluded.viewed_at`,
          [videoId, deviceId, now]
        );
        await this.d1.query('UPDATE videos SET views = views + 1 WHERE id = ?', [videoId]);
        counted = true;
      }
    } else {
      await this.d1.query('UPDATE videos SET views = views + 1 WHERE id = ?', [videoId]);
      counted = true;
    }
    const { rows } = await this.d1.query('SELECT views FROM videos WHERE id = ?', [videoId]);
    return { views: rows.length ? rows[0].views : 0, counted };
  }

  async getPasscodeHash() {
    const { rows } = await this.d1.query('SELECT value FROM settings WHERE key = ?', ['owner_passcode']);
    return rows.length ? rows[0].value : null;
  }

  async setPasscodeHash(hash) {
    await this.d1.query(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ['owner_passcode', hash]
    );
  }

  async putVideoFile(key, filePath, contentType) {
    await this.r2.putFile(key, filePath, contentType);
  }

  async deleteVideoFile(key) {
    await this.r2.deleteFile(key);
  }

  async getVideoFile(video) {
    const ext = path.extname(video.r2_key) || '.mp4';
    const tmp = tmpFile(ext);
    const { stream } = await this.r2.getStream(video.r2_key);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      stream.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      stream.on('error', reject);
    });
    return tmp;
  }

  async getVideoStream(video, range) {
    return this.r2.getStream(video.r2_key, range);
  }

  _shape(row) {
    return {
      id: row.id,
      title: row.title,
      r2_key: row.r2_key,
      width: row.width,
      height: row.height,
      duration: row.duration,
      views: row.views,
      likes: row.likes || 0,
      liked: !!row.liked,
      comments: row.comments || 0,
      created_at: row.created_at,
      stream_url: this.streamUrl(row),
    };
  }
}

// ---------------------------------------------------------------------------
// Memory store: local testing only, no credentials, no persistence
// ---------------------------------------------------------------------------
class MemoryStore {
  constructor() {
    this.mode = 'memory';
    this.videos = new Map();
    this.bytes = new Map(); // r2_key -> Buffer
    this.likes = new Set(); // `${videoId}:${deviceId}`
    this.comments = new Map(); // id -> comment
    this.views = new Map(); // `${videoId}:${deviceId}` -> viewed_at
    this.settings = new Map();
    this.nextVideoId = 1;
    this.nextCommentId = 1;
  }

  async init() { /* nothing to create */ }

  streamUrl(video) {
    return `/api/videos/${video.id}/stream`;
  }

  _counts(id) {
    let likes = 0;
    for (const k of this.likes) if (k.startsWith(`${id}:`)) likes += 1;
    let comments = 0;
    for (const c of this.comments.values()) if (c.video_id === id) comments += 1;
    return { likes, comments };
  }

  _shape(row, deviceId) {
    const { likes, comments } = this._counts(row.id);
    return {
      ...row,
      likes,
      liked: deviceId ? this.likes.has(`${row.id}:${deviceId}`) : false,
      comments,
      stream_url: this.streamUrl(row),
    };
  }

  async listVideos(deviceId) {
    return [...this.videos.values()]
      .sort((a, b) => b.created_at - a.created_at || b.id - a.id)
      .map((r) => this._shape(r, deviceId));
  }

  async getVideo(id) {
    const row = this.videos.get(id);
    return row ? this._shape(row, null) : null;
  }

  async createVideo({ title, r2Key, width, height, duration }) {
    const row = {
      id: this.nextVideoId++,
      title,
      r2_key: r2Key,
      width,
      height,
      duration,
      views: 0,
      created_at: Date.now(),
    };
    this.videos.set(row.id, row);
    return this._shape(row, null);
  }

  async updateVideoTitle(id, title) {
    const row = this.videos.get(id);
    if (!row) return null;
    row.title = title;
    return this._shape(row, null);
  }

  async deleteVideo(id) {
    const row = this.videos.get(id);
    if (!row) return null;
    this.videos.delete(id);
    this.bytes.delete(row.r2_key);
    for (const k of [...this.likes]) if (k.startsWith(`${id}:`)) this.likes.delete(k);
    for (const [cid, c] of [...this.comments]) if (c.video_id === id) this.comments.delete(cid);
    for (const k of [...this.views.keys()]) if (k.startsWith(`${id}:`)) this.views.delete(k);
    return this._shape(row, null);
  }

  async toggleLike(videoId, deviceId, liked) {
    const key = `${videoId}:${deviceId}`;
    if (liked) this.likes.add(key);
    else this.likes.delete(key);
    return { likes: this._counts(videoId).likes, liked };
  }

  async listComments(videoId) {
    return [...this.comments.values()]
      .filter((c) => c.video_id === videoId)
      .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  }

  async addComment(videoId, name, text) {
    const c = { id: this.nextCommentId++, video_id: videoId, name, text, created_at: Date.now() };
    this.comments.set(c.id, c);
    return c;
  }

  async deleteComment(id) {
    return this.comments.delete(id);
  }

  async countView(videoId, deviceId) {
    const row = this.videos.get(videoId);
    if (!row) return { views: 0, counted: false };
    const now = Date.now();
    let counted = false;
    if (deviceId) {
      const key = `${videoId}:${deviceId}`;
      const prev = this.views.get(key);
      if (!prev || now - prev > VIEW_DEDUPE_MS) {
        this.views.set(key, now);
        row.views += 1;
        counted = true;
      }
    } else {
      row.views += 1;
      counted = true;
    }
    return { views: row.views, counted };
  }

  async getPasscodeHash() {
    return this.settings.get('owner_passcode') || null;
  }

  async setPasscodeHash(hash) {
    this.settings.set('owner_passcode', hash);
  }

  async putVideoFile(key, filePath) {
    this.bytes.set(key, fs.readFileSync(filePath));
  }

  async deleteVideoFile(key) {
    this.bytes.delete(key);
  }

  async getVideoFile(video) {
    const buf = this.bytes.get(video.r2_key);
    if (!buf) throw new Error('video bytes missing from test store');
    const ext = path.extname(video.r2_key) || '.mp4';
    const tmp = tmpFile(ext);
    fs.writeFileSync(tmp, buf);
    return tmp;
  }

  getVideoBuffer(video) {
    return this.bytes.get(video.r2_key) || null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createStore(env = process.env) {
  const needed = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'CF_ACCOUNT_ID', 'CF_API_TOKEN', 'D1_DATABASE_ID'];
  const missing = needed.filter((k) => !env[k]);
  if (missing.length === 0) {
    return new R2D1Store(env);
  }
  console.warn(
    `[store] R2/D1 not fully configured (missing: ${missing.join(', ')}). ` +
    'Running with the IN-MEMORY test store: uploads, likes and comments will NOT persist. ' +
    'Set the R2_*/CF_*/D1_* env vars for production.'
  );
  return new MemoryStore();
}

module.exports = { createStore, R2D1Store, MemoryStore };
