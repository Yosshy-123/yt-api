import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { spawn } from 'node:child_process';

// ------------------------
// Config
// ------------------------
const {
  WORKER_SECRET,
  PORT = 3000,
  PROXY_URL,
} = process.env;

if (!WORKER_SECRET) {
  console.error('WORKER_SECRET is required');
  process.exit(1);
}

const app = express();
const port = Number(PORT);

const YT_DLP_BIN = '/opt/venv/bin/yt-dlp';
const YT_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

const TIMEOUT = 10000;

// ------------------------
// Auth
// ------------------------
const verifyWorkerAuth = (req, res, next) => {
  const ts = req.header('x-proxy-timestamp');
  const sig = req.header('x-proxy-signature');

  if (!ts || !sig) return res.status(401).end();

  const payload = `${ts}:${req.originalUrl}`;
  const expected = crypto
    .createHmac('sha256', WORKER_SECRET)
    .update(payload)
    .digest('hex');

  if (expected !== sig) return res.status(401).end();

  next();
};

// ------------------------
// yt-dlp
// ------------------------
const runYtDlp = (id, { proxy = false } = {}) => {
  const url = `https://www.youtube.com/watch?v=${id}`;

  const args = [
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--skip-download',
    url,
  ];

  if (proxy && PROXY_URL) {
    args.unshift('--proxy', PROXY_URL);
  }

  return new Promise((resolve, reject) => {
    const p = spawn(YT_DLP_BIN, args);

    let out = '';
    let err = '';

    const t = setTimeout(() => p.kill('SIGKILL'), TIMEOUT);

    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);

    p.on('close', code => {
      clearTimeout(t);

      if (code !== 0) {
        return reject(new Error(err || 'yt-dlp failed'));
      }

      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error('invalid json'));
      }
    });
  });
};

// ------------------------
// Format normalize（最重要）
// ------------------------
const extractUrl = (f) => {
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
  const list = [
    ...(raw.formats || []),
    ...(raw.requested_formats || []),
  ];

  return list
    .map(f => {
      const url = extractUrl(f);

      return {
        ...f,
        url,
        mime: String(f.mimeType || f.type || '').toLowerCase(),
      };
    })
    .filter(f => f.url);
};

// ------------------------
// Selector（品質最優先）
// ------------------------
const sortVideo = (a, b) =>
  (b.height || 0) - (a.height || 0) ||
  (b.fps || 0) - (a.fps || 0) ||
  (b.bitrate || 0) - (a.bitrate || 0);

const sortAudio = (a, b) =>
  (b.abr || 0) - (a.abr || 0) ||
  (b.bitrate || 0) - (a.bitrate || 0);

const getBestVideo = (f) =>
  f.filter(x => x.mime.includes('video') && !x.mime.includes('audio'))
   .sort(sortVideo)[0];

const getBestAudio = (f) =>
  f.filter(x => x.mime.includes('audio'))
   .sort(sortAudio)[0];

const getBestMuxed = (f) =>
  f.filter(x => x.mime.includes('video') && x.mime.includes('audio'))
   .sort(sortVideo)[0];

const getHLS = (f) =>
  f.find(x =>
    x.url.includes('.m3u8') ||
    x.mime.includes('mpegurl')
  );

// ------------------------
// Invidious（品質対応）
// ------------------------
const INVIDIOUS = [
  'https://inv.nadeko.net',
  'https://invidious.f5.si',
  'https://invidious.lunivers.trade',
  'https://iv.melmac.space',
  'https://yt.omada.cafe',
  'https://invidious.nerdvpn.de',
  'https://invidious.tiekoetter.com',
  'https://yewtu.be',
];

const fetchInv = async (id) => {
  for (const base of INVIDIOUS) {
    try {
      const r = await fetch(`${base}/api/v1/videos/${id}`);
      if (!r.ok) continue;

      const j = await r.json();

      const formats = [
        ...(j.formatStreams || []),
        ...(j.adaptiveFormats || []),
      ];

      return {
        raw: { formats },
        provider: base,
      };
    } catch {}
  }
  throw new Error('inv failed');
};

// ------------------------
// Fetch orchestration
// ------------------------
const fetchInfo = async (id) => {
  try {
    if (PROXY_URL) {
      return {
        raw: await runYtDlp(id, { proxy: true }),
        provider: 'yt-dlp(proxy)',
      };
    }
  } catch {}

  try {
    return await fetchInv(id);
  } catch {}

  return {
    raw: await runYtDlp(id),
    provider: 'yt-dlp',
  };
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
      return res.status(404).json({ error: 'no usable stream (empty formats)' });
    }

    // ---- HLS（ライブ）
    const hls = getHLS(formats);
    if (hls) {
      return res.json({
        resourcetype: 'hls',
        url: hls.url,
        provider: info.provider,
      });
    }

    // ---- DASH（最高品質）
    const video = getBestVideo(formats);
    const audio = getBestAudio(formats);

    if (video && audio) {
      return res.json({
        resourcetype: 'dash',
        videourl: video.url,
        audiourl: audio.url,
        provider: info.provider,
      });
    }

    // ---- fallback（mux）
    const muxed = getBestMuxed(formats);
    if (muxed) {
      return res.json({
        resourcetype: 'progressive',
        url: muxed.url,
        provider: info.provider,
      });
    }

    // ---- 最終fallback（videoのみでも返す）
    const any = formats.sort(sortVideo)[0];
    if (any) {
      return res.json({
        resourcetype: 'fallback',
        url: any.url,
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
