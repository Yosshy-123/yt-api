import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { spawn } from 'node:child_process';

// ------------------------
// Config
// ------------------------
const { WORKER_SECRET, PORT = 3000, PROXY_URL } = process.env;

if (!WORKER_SECRET) {
  console.error('WORKER_SECRET is required');
  process.exit(1);
}

const app = express();
const port = Number(PORT) || 3000;

const ALLOWED_WINDOW_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 5000;
const INSTANCE_BAN_MS = 5 * 60 * 1000;
const YT_DLP_TIMEOUT_MS = 10000;
const YT_DLP_BIN = '/opt/venv/bin/yt-dlp';

const YT_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.f5.si',
  'https://invidious.lunivers.trade',
  'https://iv.melmac.space',
  'https://yt.omada.cafe',
  'https://invidious.nerdvpn.de',
  'https://invidious.tiekoetter.com',
  'https://yewtu.be',
];

// ------------------------
// Auth
// ------------------------
const safeEqualHex = (a, b) => {
  try {
    const A = Buffer.from(String(a), 'hex');
    const B = Buffer.from(String(b), 'hex');
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
};

const verifyWorkerAuth = (req, res, next) => {
  const ts = req.header('x-proxy-timestamp');
  const sig = req.header('x-proxy-signature');

  if (!ts || !sig) return res.status(401).json({ error: 'unauthorized' });

  const now = Math.floor(Date.now() / 1000);
  const t = Number(ts);

  if (!Number.isFinite(t) || Math.abs(now - t) > ALLOWED_WINDOW_SECONDS) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const payload = `${ts}:${req.originalUrl}`;
  const expected = crypto.createHmac('sha256', WORKER_SECRET).update(payload).digest('hex');

  if (!safeEqualHex(expected, sig)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  next();
};

// ------------------------
// yt-dlp
// ------------------------
const runYtDlp = (videoId, { useProxy = false } = {}) => {
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const args = [
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--skip-download',
    '--extractor-args', 'youtube:player_client=android',
    url,
  ];

  if (useProxy && PROXY_URL) {
    args.unshift('--proxy', PROXY_URL);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP_BIN, args);

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => child.kill('SIGKILL'), YT_DLP_TIMEOUT_MS);

    child.stdout.on('data', d => (stdout += d.toString()));
    child.stderr.on('data', d => (stderr += d.toString()));

    child.on('close', (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        return reject(new Error(stderr));
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('invalid json'));
      }
    });
  });
};

// ------------------------
// Format Utils
// ------------------------
const parseUrl = (f) => {
  if (!f) return null;
  if (f.url) return f.url;

  const cipher = f.signatureCipher || f.cipher;
  if (!cipher) return null;

  try {
    return new URLSearchParams(cipher).get('url');
  } catch {
    return null;
  }
};

const normalizeFormats = (raw = {}) => {
  const list = raw.formats || [];

  return list
    .map(f => ({
      ...f,
      url: parseUrl(f),
      mime: String(f.mimeType || f.type || '').toLowerCase(),
    }))
    .filter(f => f.url);
};

const bestVideo = (f) =>
  f
    .filter(x => x.mime.includes('video') && !x.mime.includes('audio'))
    .sort((a, b) =>
      (b.height || 0) - (a.height || 0) ||
      (b.fps || 0) - (a.fps || 0) ||
      (b.bitrate || 0) - (a.bitrate || 0)
    )[0];

const bestAudio = (f) =>
  f
    .filter(x => x.mime.includes('audio'))
    .sort((a, b) =>
      (b.abr || 0) - (a.abr || 0) ||
      (b.bitrate || 0) - (a.bitrate || 0)
    )[0];

const bestMuxed = (f) =>
  f
    .filter(x => x.mime.includes('video') && x.mime.includes('audio'))
    .sort((a, b) =>
      (b.height || 0) - (a.height || 0) ||
      (b.bitrate || 0) - (a.bitrate || 0)
    )[0];

const findHLS = (f) =>
  f.find(x =>
    x.url?.includes('.m3u8') ||
    x.mime.includes('mpegurl')
  );

// ------------------------
// Invidious
// ------------------------
const fetchInvidious = async (id) => {
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const res = await fetch(`${base}/api/v1/videos/${id}`);
      if (!res.ok) continue;

      const data = await res.json();

      const formats = [
        ...(data.formatStreams || []),
        ...(data.adaptiveFormats || []),
      ].map(f => ({
        ...f,
        mimeType: f.type,
      }));

      return {
        raw: { formats },
        provider: base,
      };
    } catch {}
  }
  throw new Error('inv failed');
};

// ------------------------
// Unified Fetch
// ------------------------
const fetchInfo = async (id) => {
  try {
    if (PROXY_URL) {
      const raw = await runYtDlp(id, { useProxy: true });
      return { raw, provider: 'yt-dlp(proxy)' };
    }
  } catch {}

  try {
    return await fetchInvidious(id);
  } catch {}

  const raw = await runYtDlp(id);
  return { raw, provider: 'yt-dlp' };
};

// ------------------------
// API
// ------------------------
app.get('/api/stream', verifyWorkerAuth, async (req, res) => {
  try {
    const id = String(req.query.id || '');
    if (!YT_ID_REGEX.test(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }

    const info = await fetchInfo(id);
    const formats = normalizeFormats(info.raw);

    if (!formats.length) {
      return res.status(404).json({ error: 'no stream' });
    }

    const hls = findHLS(formats);
    if (hls) {
      return res.json({
        resourcetype: 'hls',
        url: hls.url,
        provider: info.provider,
      });
    }

    const video = bestVideo(formats);
    const audio = bestAudio(formats);

    if (video && audio) {
      return res.json({
        resourcetype: 'dash',
        videourl: video.url,
        audiourl: audio.url,
        provider: info.provider,
      });
    }

    const muxed = bestMuxed(formats);
    if (muxed) {
      return res.json({
        resourcetype: 'progressive',
        url: muxed.url,
        provider: info.provider,
      });
    }

    return res.status(404).json({ error: 'no usable stream' });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ------------------------
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
