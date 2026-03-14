import express from 'express';
import { Innertube } from 'youtubei.js';
import crypto from 'crypto';

const { WORKER_SECRET, PORT } = process.env;
if (!WORKER_SECRET) {
  console.error('WORKER_SECRET is required');
  process.exit(1);
}

const app = express();
const port = PORT || 3000;
const ALLOWED_WINDOW = 300;
const INSTANCE_BAN_MS = 5 * 60 * 1000;
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

let ytClient = null;
const getYtClient = async () => {
  if (!ytClient) {
    ytClient = await Innertube.create({
      client_type: 'ANDROID',
      generate_session_locally: true,
    });
  }
  return ytClient;
};

const badInstances = new Map();
let rrIndex = 0;
const markBad = (instance) => {
  try { badInstances.set(instance, Date.now()); } catch {}
  console.info('markBad', instance);
};

const rotateInstances = (list) => {
  if (!Array.isArray(list) || list.length === 0) return [];
  const start = rrIndex % list.length;
  rrIndex = (start + 1) % list.length;
  const rotated = [...list.slice(start), ...list.slice(0, start)];
  const good = rotated.filter((i) => {
    const t = badInstances.get(i);
    if (!t) return true;
    if (Date.now() - t > INSTANCE_BAN_MS) {
      badInstances.delete(i);
      return true;
    }
    return false;
  });
  return good.length ? good : rotated;
};

const parseUrl = (format) => {
  if (!format) return null;
  if (format.url) return format.url;
  const cipher = format.signatureCipher || format.signature_cipher || format.cipher;
  if (!cipher) return null;
  try {
    return new URLSearchParams(cipher).get('url');
  } catch {
    return null;
  }
};

const normalizeFormats = (sd = {}) => [
  ...(sd.formats || []),
  ...(sd.adaptive_formats || []),
].map((f) => ({
  ...f,
  mime: (f.mimeType || f.mime_type || f.type || '').toLowerCase(),
}));

const selectBestVideo = (formats) =>
  formats
    .filter((f) => f.mime.includes('video'))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0))[0] || null;

const selectBestAudio = (formats) =>
  formats
    .filter((f) => f.mime.includes('audio'))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0] || null;

const selectBestProgressive = (formats) =>
  formats
    .filter((f) => f.mime.includes('video') && /mp4a|aac|opus/.test(f.mime))
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0] || null;

const fetchWithTimeout = async (url, opts = {}, ms = 5000, controller = null) => {
  const localController = controller || new AbortController();
  const signal = localController.signal;
  const timer = setTimeout(() => localController.abort(), ms);
  try {
    const res = await fetch(url, { signal, ...opts });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
};

const verifyCdn = async (url, timeoutMs = 4000) => {
  if (!url) return false;
  try {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      redirect: 'follow',
    }, timeoutMs);
    if (!res) return false;
    return res.status === 206 || res.status === 200;
  } catch {
    return false;
  }
};

const fastestValidInstance = async (instances, buildUrl, parser) => {
  if (!instances || instances.length === 0) throw new Error('no instances');
  const controllers = new Map();
  const INSTANCE_FETCH_TIMEOUT = 5000;
  const instancePromises = instances.map((base) => new Promise(async (resolve, reject) => {
    const controller = new AbortController();
    controllers.set(base, controller);
    try {
      const res = await fetchWithTimeout(buildUrl(base), {}, INSTANCE_FETCH_TIMEOUT, controller);
      if (!res || !res.ok) {
        markBad(base);
        return reject(new Error(`instance fetch failed ${base} status=${res ? res.status : 'no-res'}`));
      }
      const data = await res.json();
      const parsed = parser(data);
      if (!parsed || !parsed.streaming_data) {
        markBad(base);
        return reject(new Error(`instance parse failed ${base}`));
      }
      const sd = parsed.streaming_data;
      const formats = normalizeFormats(sd);
      const video = selectBestVideo(formats);
      const audio = selectBestAudio(formats);
      const progressive = selectBestProgressive(formats);
      const candidates = [];
      if (video && audio) {
        const v = parseUrl(video);
        const a = parseUrl(audio);
        if (v && a) candidates.push([v, a]);
      }
      if (progressive) {
        const p = parseUrl(progressive);
        if (p) candidates.push([p]);
      }
      if (!candidates.length) {
        markBad(base);
        return reject(new Error(`no usable formats ${base}`));
      }
      for (const urls of candidates) {
        const checks = await Promise.all(urls.map((u) => verifyCdn(u)));
        if (checks.every(Boolean)) {
          return resolve({ instance: base, streaming_data: sd });
        }
      }
      markBad(base);
      return reject(new Error(`cdn validation failed ${base}`));
    } catch (err) {
      markBad(base);
      return reject(err);
    }
  })));
  try {
    const winner = await Promise.any(instancePromises);
    console.info('invidious winner', winner.instance);
    for (const [k, ctrl] of controllers.entries()) {
      if (k !== winner.instance) {
        try { ctrl.abort(); } catch {}
      }
    }
    return winner;
  } catch (aggErr) {
    for (const ctrl of controllers.values()) {
      try { ctrl.abort(); } catch {}
    }
    throw new Error('no valid invidious instance');
  }
};

const fetchFromInvidious = async (id) => {
  const instances = rotateInstances(INVIDIOUS_INSTANCES);
  const result = await fastestValidInstance(
    instances,
    (base) => `${base}/api/v1/videos/${id}`,
    (data) => {
      const formats = [];
      (data.formatStreams || []).forEach((f) => formats.push({ ...f, mimeType: f.type || f.mimeType }));
      (data.adaptiveFormats || []).forEach((f) => formats.push({ ...f, mimeType: f.type || f.mimeType }));
      if (!formats.length) return null;
      return { streaming_data: { formats } };
    }
  );
  return {
    provider: 'invidious',
    instance: result.instance,
    streaming_data: result.streaming_data,
  };
};

const fetchFromInnertube = async (id) => {
  const client = await getYtClient();
  const info = await client.getInfo(id);
  if (!info?.streaming_data) throw new Error('No streaming data from innertube');
  return {
    provider: 'innertube',
    streaming_data: info.streaming_data,
  };
};

const fetchStreamingInfo = async (id) => {
  try {
    return await fetchFromInvidious(id);
  } catch (e) {
    const inn = await fetchFromInnertube(id);
    const sd = inn.streaming_data || {};
    const formats = normalizeFormats(sd);
    const video = selectBestVideo(formats);
    const audio = selectBestAudio(formats);
    const progressive = selectBestProgressive(formats);
    const verifySet = async () => {
      if (video && audio) {
        const v = parseUrl(video);
        const a = parseUrl(audio);
        if (!v || !a) return false;
        const [vOk, aOk] = await Promise.all([verifyCdn(v), verifyCdn(a)]);
        return vOk && aOk;
      }
      if (progressive) {
        const p = parseUrl(progressive);
        if (!p) return false;
        return await verifyCdn(p);
      }
      return false;
    };
    const ok = await verifySet();
    if (!ok) throw new Error('innertube cdn unreachable');
    return inn;
  }
};

const safeEqual = (a, b) => {
  try {
    const A = Buffer.from(a, 'hex');
    const B = Buffer.from(b, 'hex');
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
  if (!Number.isFinite(t) || Math.abs(now - t) > ALLOWED_WINDOW)
    return res.status(401).json({ error: 'unauthorized' });
  const payload = `${ts}:${req.originalUrl}`;
  const expected = crypto.createHmac('sha256', WORKER_SECRET).update(payload).digest('hex');
  if (!safeEqual(expected, sig)) return res.status(401).json({ error: 'unauthorized' });
  next();
};

function isValidVideoId(id) {
  return typeof id === "string" && YT_ID_REGEX.test(id);
}

app.get('/api/stream', verifyWorkerAuth, async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!isValidVideoId(id)) return res.status(400).json({ error: 'invalid video id' });
    const info = await fetchStreamingInfo(String(id));
    const sd = info.streaming_data || {};
    const hls = sd.hlsManifestUrl || sd.hls_manifest_url || sd.hlsUrl || sd.hls;
    if (hls) return res.status(403).json({ error: 'HLS streams are not supported' });
    const formats = normalizeFormats(sd);
    const video = selectBestVideo(formats);
    const audio = selectBestAudio(formats);
    const progressive = selectBestProgressive(formats);
    if (video && audio) {
      const vUrl = parseUrl(video);
      const aUrl = parseUrl(audio);
      if (!vUrl || !aUrl) return res.status(404).json({ error: 'no stream url' });
      return res.json({
        type: 'dash',
        video_url: vUrl,
        audio_url: aUrl,
        provider: info.provider,
        instance: info.instance || null,
      });
    }
    if (progressive) {
      const pUrl = parseUrl(progressive);
      if (!pUrl) return res.status(404).json({ error: 'no stream url' });
      return res.json({
        type: 'progressive',
        url: pUrl,
        provider: info.provider,
        instance: info.instance || null,
      });
    }
    return res.status(404).json({ error: 'no stream' });
  } catch (e) {
    console.error('stream error:', e?.message || e);
    return res.status(502).json({ error: e?.message || 'internal error' });
  }
});

app.listen(port, () => console.info(`Server running on ${port}`));
