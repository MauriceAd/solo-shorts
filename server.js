/**
 * Solo Shorts — link-only short-video site (free stack).
 *
 * - Anyone with the link can watch (no login, no age gate, no verification).
 * - Only the owner uploads (passcode set on first use, no reset).
 * - Viewers can like, comment and download. Downloads carry the site logo
 *   burned in; streamed playback stays clean.
 *
 * Storage (see lib/store.js):
 *  - Production: videos in Cloudflare R2, metadata in Cloudflare D1.
 *    Playback goes through the R2 public URL (R2_PUBLIC_BASE_URL).
 *  - Local / no credentials: an in-memory test store. Nothing persists.
 *
 * Run:  npm install && node server.js
 * Env:  PORT (default 3000)
 *       R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
 *       R2_PUBLIC_BASE_URL, CF_ACCOUNT_ID, CF_API_TOKEN, D1_DATABASE_ID
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const { createStore } = require('./lib/store');

const PORT = parseInt(process.env.PORT || '3000', 10);
const WATERMARK_PNG = path.join(__dirname, 'assets', 'watermark.png');
const DOWNLOAD_CACHE_DIR = path.join(os.tmpdir(), 'ss-downloads');

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);
const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};
const MAX_TITLE_LEN = 120;
const MAX_NAME_LEN = 40;
const MAX_COMMENT_LEN = 500;

fs.mkdirSync(DOWNLOAD_CACHE_DIR, { recursive: true });

const store = createStore();

// S3 client used ONLY to sign direct-to-R2 upload URLs. The browser uploads
// straight to R2 (presigned PUT), bypassing this small container/proxy for
// the large transfer. In memory-store mode (no R2 creds) dummy values keep
// signing working for local tests; the resulting URL simply cannot upload
// to real R2. Content-Type is deliberately NOT part of the signed request,
// so the browser may send the file's own type without breaking the signature.
const presignS3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT || 'https://example.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || 'test',
  },
});
const PRESIGN_BUCKET = process.env.R2_BUCKET || 'solo-shorts-videos';
const PRESIGN_TTL_S = 900; // 15 minutes

// Wrap async route handlers so a rejected promise reaches the error
// middleware instead of crashing the process (Express 4 does not do this).
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Owner auth (scrypt-hashed passcode, random bearer token in a cookie)
// ---------------------------------------------------------------------------
const ownerTokens = new Set(); // in-memory; owner re-logs in after a restart

async function getPasscodeHash() {
  return store.getPasscodeHash();
}

async function setPasscode(passcode) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(passcode, salt, 64);
  await store.setPasscodeHash(`scrypt:${salt.toString('hex')}:${hash.toString('hex')}`);
}

async function verifyPasscode(passcode) {
  const stored = await getPasscodeHash();
  if (!stored) return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(passcode, salt, 64);
  return crypto.timingSafeEqual(expected, actual);
}

function issueOwnerToken(res) {
  const token = crypto.randomBytes(32).toString('hex');
  ownerTokens.add(token);
  res.cookie('ss_owner', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
  return token;
}

function ownerTokenFromReq(req) {
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const cookie = req.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)ss_owner=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function requireOwner(req, res, next) {
  const token = ownerTokenFromReq(req);
  if (token && ownerTokens.has(token)) return next();
  return res.status(401).json({ error: 'owner login required' });
}

// Tiny brute-force guard for the login/setup endpoints.
const loginAttempts = new Map(); // ip -> { count, resetAt }
function loginRateLimited(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (entry && entry.resetAt < now) loginAttempts.delete(ip);
  const cur = loginAttempts.get(ip) || { count: 0, resetAt: now + 60 * 1000 };
  if (cur.count >= 10) return res.status(429).json({ error: 'too many attempts, try again in a minute' });
  cur.count += 1;
  loginAttempts.set(ip, cur);
  next();
}
function clearLoginAttempts(req) {
  loginAttempts.delete(req.ip || 'unknown');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseVideoId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid video id' });
    return null;
  }
  return id;
}

async function getVideoOr404(id, res) {
  const row = await store.getVideo(id);
  if (!row) {
    res.status(404).json({ error: 'video not found' });
    return null;
  }
  return row;
}

function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'quiet', '-print_format', 'json',
      '-show_streams', '-show_format', filePath,
    ]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${err.trim()}`));
      try {
        const info = JSON.parse(out);
        const v = (info.streams || []).find((s) => s.codec_type === 'video') || {};
        const hasAudio = (info.streams || []).some((s) => s.codec_type === 'audio');
        resolve({
          width: v.width || null,
          height: v.height || null,
          duration: info.format && info.format.duration ? parseFloat(info.format.duration) : null,
          hasAudio,
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Watermarked download (ffmpeg burn-in, cached in the OS temp dir)
// ---------------------------------------------------------------------------
const downloadJobs = new Map(); // videoId -> Promise<string> (output path)

function even(n) {
  return Math.max(2, Math.floor(n / 2) * 2);
}

function cachedDownloadPath(videoId) {
  return path.join(DOWNLOAD_CACHE_DIR, `${videoId}.mp4`);
}

async function buildWatermarked(video) {
  const out = cachedDownloadPath(video.id);
  if (fs.existsSync(out)) return out;
  if (downloadJobs.has(video.id)) return downloadJobs.get(video.id);

  const job = (async () => {
    const src = await store.getVideoFile(video); // temp file; caller-owned, we clean up
    try {
      const info = await probeVideo(src);
      const vw = info.width || 720;
      const vh = info.height || 1280;
      // Watermark PNG is 480x452. Scale to 18% of video width, keep aspect.
      const wmW = even(vw * 0.18);
      const wmH = even((wmW * 452) / 480);
      const x = even(vw - wmW - 12);
      const y = even(vh - wmH - 12);
      const filter = `[1:v]scale=${wmW}:${wmH}[wm];[0:v][wm]overlay=${x}:${y},format=yuv420p`;
      const args = [
        '-y', '-i', src, '-i', WATERMARK_PNG,
        '-filter_complex', filter,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-movflags', '+faststart',
      ];
      if (info.hasAudio) args.push('-c:a', 'copy');
      args.push(out);

      await new Promise((resolve, reject) => {
        const p = spawn('ffmpeg', args);
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, 10 * 60 * 1000);
        p.on('error', (e) => { clearTimeout(timer); reject(e); });
        p.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0 && fs.existsSync(out)) resolve();
          else reject(new Error(`ffmpeg failed (code ${code}): ${err.slice(-500)}`));
        });
      });
      return out;
    } finally {
      try { fs.unlinkSync(src); } catch (e) { /* ignore */ }
    }
  })();

  downloadJobs.set(video.id, job);
  job.catch(() => {}).finally(() => downloadJobs.delete(video.id));
  return job;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// --- Public API ------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true, store: store.mode }));

app.get('/api/videos', asyncHandler(async (req, res) => {
  const deviceId = typeof req.query.device === 'string' ? req.query.device.slice(0, 64) : null;
  try {
    res.json(await store.listVideos(deviceId));
  } catch (e) {
    console.error('listVideos failed:', e.message);
    res.status(500).json({ error: 'could not load videos' });
  }
}));

app.get('/api/videos/:id/comments', asyncHandler(async (req, res) => {
  const id = parseVideoId(req, res);
  if (id === null) return;
  if (!(await getVideoOr404(id, res))) return;
  res.json(await store.listComments(id));
}));

app.post('/api/videos/:id/comments', asyncHandler(async (req, res) => {
  const id = parseVideoId(req, res);
  if (id === null) return;
  if (!(await getVideoOr404(id, res))) return;
  const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, MAX_NAME_LEN) : '';
  const text = typeof req.body.text === 'string' ? req.body.text.trim().slice(0, MAX_COMMENT_LEN) : '';
  if (!name || !text) return res.status(400).json({ error: 'name and comment text are required' });
  res.status(201).json(await store.addComment(id, name, text));
}));

app.post('/api/videos/:id/like', asyncHandler(async (req, res) => {
  const id = parseVideoId(req, res);
  if (id === null) return;
  if (!(await getVideoOr404(id, res))) return;
  const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.trim().slice(0, 64) : '';
  if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
  res.json(await store.toggleLike(id, deviceId, req.body.liked === true));
}));

app.post('/api/videos/:id/view', asyncHandler(async (req, res) => {
  const id = parseVideoId(req, res);
  if (id === null) return;
  if (!(await getVideoOr404(id, res))) return;
  const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.trim().slice(0, 64) : '';
  res.json(await store.countView(id, deviceId));
}));

// Stream endpoint.
//  - Memory store: serves the bytes with HTTP Range support.
//  - R2 store: redirects to the R2 public URL when one is configured;
//    otherwise proxies the object from R2 (Range header passed through).
app.get('/api/videos/:id/stream', asyncHandler(async (req, res) => {
  const id = parseVideoId(req, res);
  if (id === null) return;
  const video = await getVideoOr404(id, res);
  if (!video) return;

  if (store.mode === 'r2-d1') {
    const url = store.streamUrl(video);
    if (url) return res.redirect(302, url);
    try {
      const r = await store.getVideoStream(video, req.headers.range);
      res.writeHead(r.statusCode === 206 ? 206 : 200, {
        'Content-Type': r.contentType || 'video/mp4',
        ...(r.contentLength != null ? { 'Content-Length': r.contentLength } : {}),
        ...(r.contentRange ? { 'Content-Range': r.contentRange } : {}),
        'Accept-Ranges': 'bytes',
      });
      return r.stream.pipe(res);
    } catch (e) {
      console.error('R2 stream failed:', e.message);
      return res.status(502).json({ error: 'could not load video from storage' });
    }
  }

  // Memory store
  const buf = store.getVideoBuffer(video);
  if (!buf) return res.status(404).json({ error: 'video file missing' });
  const ext = path.extname(video.r2_key).toLowerCase();
  const contentType = MIME_BY_EXT[ext] || 'video/mp4';
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': buf.length, 'Accept-Ranges': 'bytes' });
    return res.end(buf);
  }
  const m = range.match(/bytes=(\d*)-(\d*)/);
  if (!m) return res.status(416).end();
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : buf.length - 1;
  if (Number.isNaN(start) || start >= buf.length) {
    return res.status(416).set('Content-Range', `bytes */${buf.length}`).end();
  }
  end = Math.min(end, buf.length - 1);
  res.writeHead(206, {
    'Content-Type': contentType,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${buf.length}`,
    'Accept-Ranges': 'bytes',
  });
  res.end(buf.subarray(start, end + 1));
}));

app.get('/api/videos/:id/download', asyncHandler(async (req, res) => {
  const id = parseVideoId(req, res);
  if (id === null) return;
  const video = await getVideoOr404(id, res);
  if (!video) return;
  try {
    const out = await buildWatermarked(video);
    const safeTitle = (video.title || 'video')
      .replace(/[^a-zA-Z0-9-_ ]/g, '')
      .trim()
      .replace(/\s+/g, '-') || 'video';
    res.download(out, `${safeTitle}.mp4`);
  } catch (e) {
    console.error('download build failed for video', id, e.message);
    res.status(500).json({ error: 'could not prepare download, please try again' });
  }
}));

// --- Owner API -------------------------------------------------------------
app.get('/api/owner/status', asyncHandler(async (req, res) => {
  const token = ownerTokenFromReq(req);
  res.json({ passcodeSet: !!(await getPasscodeHash()), loggedIn: !!(token && ownerTokens.has(token)) });
}));

app.post('/api/owner/setup', loginRateLimited, asyncHandler(async (req, res) => {
  if (await getPasscodeHash()) return res.status(400).json({ error: 'passcode is already set' });
  const passcode = typeof req.body.passcode === 'string' ? req.body.passcode : '';
  if (passcode.length < 4) return res.status(400).json({ error: 'passcode must be at least 4 characters' });
  await setPasscode(passcode);
  clearLoginAttempts(req);
  const token = issueOwnerToken(res);
  res.json({ ok: true, token });
}));

app.post('/api/owner/login', loginRateLimited, asyncHandler(async (req, res) => {
  if (!(await getPasscodeHash())) return res.status(400).json({ error: 'no passcode set yet — set one first' });
  const passcode = typeof req.body.passcode === 'string' ? req.body.passcode : '';
  if (!(await verifyPasscode(passcode))) return res.status(401).json({ error: 'wrong passcode' });
  clearLoginAttempts(req);
  const token = issueOwnerToken(res);
  res.json({ ok: true, token });
}));

app.post('/api/owner/logout', (req, res) => {
  const token = ownerTokenFromReq(req);
  if (token) ownerTokens.delete(token);
  res.clearCookie('ss_owner', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/owner/videos', requireOwner, asyncHandler(async (req, res) => {
  res.json(await store.listVideos(null));
}));

// --- Direct-to-R2 upload (presigned PUT) -----------------------------------
// The browser uploads the file straight to R2 and then confirms, so the
// large transfer never passes through this container/proxy.
// POST /api/videos/presign -> { uploadUrl, r2Key }
// POST /api/videos/confirm -> creates the video record, 201 with the video
app.post('/api/videos/presign', requireOwner, asyncHandler(async (req, res) => {
  const filename = typeof req.body.filename === 'string' ? req.body.filename : '';
  const contentType = typeof req.body.contentType === 'string' ? req.body.contentType : '';
  const ext = path.extname(filename).toLowerCase();
  if (!VIDEO_EXTS.has(ext) || !contentType.startsWith('video/')) {
    return res.status(400).json({ error: 'only video files are allowed (.mp4, .mov, .webm, .mkv, .m4v)' });
  }
  const r2Key = `videos/${crypto.randomUUID()}${ext}`;
  try {
    const uploadUrl = await getSignedUrl(presignS3, new PutObjectCommand({
      Bucket: PRESIGN_BUCKET,
      Key: r2Key,
    }), { expiresIn: PRESIGN_TTL_S });
    res.json({ uploadUrl, r2Key });
  } catch (e) {
    console.error('presign failed:', e.message);
    res.status(500).json({ error: 'could not prepare upload, please try again' });
  }
}));

app.post('/api/videos/confirm', requireOwner, asyncHandler(async (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim().slice(0, MAX_TITLE_LEN) : '';
  const r2Key = typeof req.body.r2Key === 'string' ? req.body.r2Key : '';
  if (!title) return res.status(400).json({ error: 'a title is required' });
  if (!/^videos\/[0-9a-f-]+\.(mp4|mov|webm|mkv|m4v)$/.test(r2Key)) {
    return res.status(400).json({ error: 'invalid video reference' });
  }
  const width = typeof req.body.width === 'number' && Number.isFinite(req.body.width)
    ? Math.round(req.body.width) : null;
  const height = typeof req.body.height === 'number' && Number.isFinite(req.body.height)
    ? Math.round(req.body.height) : null;
  const duration = typeof req.body.duration === 'number' && Number.isFinite(req.body.duration)
    ? req.body.duration : null;
  try {
    const video = await store.createVideo({ title, r2Key, width, height, duration });
    res.status(201).json(video);
  } catch (e) {
    console.error('confirm failed:', e.message);
    res.status(500).json({ error: 'could not save video details' });
  }
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `ss-upload-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${VIDEO_EXTS.has(ext) ? ext : '.mp4'}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (VIDEO_EXTS.has(ext) && (file.mimetype || '').startsWith('video/')) return cb(null, true);
    cb(new Error('only video files are allowed (.mp4, .mov, .webm, .mkv, .m4v)'));
  },
});

app.post('/api/videos', requireOwner, (req, res) => {
  upload.single('video')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'video is too large (max 200 MB)'
        : (err.message || 'upload failed');
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'no video file received' });
    const title = typeof req.body.title === 'string' ? req.body.title.trim().slice(0, MAX_TITLE_LEN) : '';
    if (!title) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'a title is required' });
    }
    let probe;
    try {
      probe = await probeVideo(req.file.path);
    } catch (e) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'that file is not a playable video' });
    }
    const ext = path.extname(req.file.filename).toLowerCase();
    const r2Key = `videos/${crypto.randomUUID()}${ext}`;
    const contentType = MIME_BY_EXT[ext] || 'video/mp4';
    try {
      await store.putVideoFile(r2Key, req.file.path, contentType);
    } catch (e) {
      console.error('storage upload failed:', e.message);
      fs.unlinkSync(req.file.path);
      return res.status(502).json({ error: 'could not save video to storage' });
    }
    fs.unlinkSync(req.file.path);
    try {
      const video = await store.createVideo({
        title, r2Key, width: probe.width, height: probe.height, duration: probe.duration,
      });
      res.status(201).json(video);
    } catch (e) {
      console.error('metadata save failed:', e.message);
      try { await store.deleteVideoFile(r2Key); } catch (_) { /* ignore */ }
      res.status(500).json({ error: 'could not save video details' });
    }
  });
});

app.patch('/api/videos/:id', requireOwner, asyncHandler(async (req, res) => {
  const id = parseVideoId(req, res);
  if (id === null) return;
  if (!(await getVideoOr404(id, res))) return;
  const title = typeof req.body.title === 'string' ? req.body.title.trim().slice(0, MAX_TITLE_LEN) : '';
  if (!title) return res.status(400).json({ error: 'a title is required' });
  res.json(await store.updateVideoTitle(id, title));
}));

app.delete('/api/videos/:id', requireOwner, asyncHandler(async (req, res) => {
  const id = parseVideoId(req, res);
  if (id === null) return;
  const video = await getVideoOr404(id, res);
  if (!video) return;
  await store.deleteVideo(id);
  try { await store.deleteVideoFile(video.r2_key); } catch (e) { console.error('delete object failed:', e.message); }
  try { if (fs.existsSync(cachedDownloadPath(id))) fs.unlinkSync(cachedDownloadPath(id)); } catch (e) { /* ignore */ }
  res.json({ ok: true });
}));

app.delete('/api/comments/:id', requireOwner, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid comment id' });
  const ok = await store.deleteComment(id);
  if (!ok) return res.status(404).json({ error: 'comment not found' });
  res.json({ ok: true });
}));

// --- Static frontend -------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// --- Errors ----------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server error' });
});

// --- Start -----------------------------------------------------------------
(async () => {
  try {
    await store.init();
    console.log(`[store] ${store.mode} ready`);
  } catch (e) {
    console.error(`[store] init failed (${store.mode}): ${e.message}`);
    console.error('[store] The server will still start, but video endpoints will fail until storage is configured.');
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`solo shorts listening on port ${PORT} (store: ${store.mode})`);
  });
})();
