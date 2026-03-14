import express from "express";
import { Innertube } from "youtubei.js";
import crypto from "crypto";

if (!process.env.WORKER_SECRET) {
  console.error("WORKER_SECRET is required");
  process.exit(1);
}

const app = express();
const port = process.env.PORT || 3000;
const WORKER_SECRET = process.env.WORKER_SECRET;
const ALLOWED_WINDOW = 300;
const INSTANCE_BAN_MS = 5 * 60 * 1000;

/* ---------------- Instances ---------------- */

const INSTANCES = {
  invidious: [
    "https://inv.nadeko.net",
    "https://invidious.f5.si",
    "https://invidious.lunivers.trade",
    "https://iv.melmac.space",
    "https://yt.omada.cafe",
    "https://invidious.nerdvpn.de",
    "https://invidious.tiekoetter.com",
    "https://yewtu.be",
  ],
  piped: [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.leptons.xyz",
    "https://pipedapi.nosebs.ru",
    "https://pipedapi-libre.kavin.rocks",
    "https://piped-api.privacy.com.de",
    "https://pipedapi.adminforge.de",
    "https://api.piped.yt",
    "https://pipedapi.drgns.space",
    "https://pipedapi.owo.si",
    "https://pipedapi.ducks.party",
    "https://piped-api.codespace.cz",
    "https://pipedapi.reallyaweso.me",
    "https://api.piped.private.coffee",
    "https://pipedapi.darkness.services",
    "https://pipedapi.orangenet.cc",
  ],
};

const badInstances = new Map();
const nextIndex = { invidious: 0, piped: 0 };

const rotateInstances = (key) => {
  const list = INSTANCES[key];
  const idx = nextIndex[key] % list.length;
  nextIndex[key] = (idx + 1) % list.length;

  const rotated = [...list.slice(idx), ...list.slice(0, idx)];
  const good = rotated.filter(i => !isBad(i));

  return good.length ? good : rotated;
};

const markBad = (instance) => badInstances.set(instance, Date.now());
const isBad = (instance) => {
  const t = badInstances.get(instance);
  if (!t) return false;
  if (Date.now() - t > INSTANCE_BAN_MS) {
    badInstances.delete(instance);
    return false;
  }
  return true;
};

/* ---------------- Innertube ---------------- */

let ytClient;
const getYtClient = async () => {
  if (!ytClient) {
    ytClient = await Innertube.create({
      client_type: "ANDROID",
      generate_session_locally: true
    });
  }
  return ytClient;
};

/* ---------------- Utilities ---------------- */

const safeEqual = (a,b) => {
  const A = Buffer.from(a,"hex");
  const B = Buffer.from(b,"hex");
  return A.length === B.length && crypto.timingSafeEqual(A,B);
};

const verifyWorkerAuth = (req,res,next) => {
  const ts = req.header("x-proxy-timestamp");
  const sig = req.header("x-proxy-signature");
  if (!ts || !sig) return res.status(401).json({error:"unauthorized"});

  const now = Math.floor(Date.now()/1000);
  if (Math.abs(now - Number(ts)) > ALLOWED_WINDOW)
    return res.status(401).json({error:"unauthorized"});

  const expected = crypto
    .createHmac("sha256", WORKER_SECRET)
    .update(`${ts}:${req.originalUrl}`)
    .digest("hex");

  if (!safeEqual(expected, sig)) return res.status(401).json({error:"unauthorized"});
  next();
};

const parseUrl = (format) => format.url || new URLSearchParams(format.signatureCipher || format.signature_cipher || format.cipher || "").get("url");
const normalizeFormats = (sd) => [...(sd.formats || []), ...(sd.adaptive_formats || [])].map(f => ({ ...f, mime: (f.mimeType || f.mime_type || "").toLowerCase() }));

const selectBestVideo = (formats) => formats.filter(f => f.mime.includes("video")).sort((a,b)=> (b.height||0)-(a.height||0) || (b.bitrate||0)-(a.bitrate||0))[0] || null;
const selectBestAudio = (formats) => formats.filter(f => f.mime.includes("audio")).sort((a,b)=> (b.bitrate||0)-(a.bitrate||0))[0] || null;
const selectBestProgressive = (formats) => formats.filter(f => f.mime.includes("video") && /mp4a|aac|opus/.test(f.mime)).sort((a,b)=> (b.height||0)-(a.height||0))[0] || null;

/* ---------------- Parallel Fetch ---------------- */

const fastestFetch = async (instances, buildUrl, parser) => {
  const controllers = [];
  const tasks = instances.map(base => {
    const controller = new AbortController();
    controllers.push(controller);
    return fetch(buildUrl(base), { signal: controller.signal })
      .then(res => {
        if (!res.ok) { markBad(base); throw new Error(); }
        return res.json();
      })
      .then(data => {
        const parsed = parser(data, base);
        if (!parsed) throw new Error();
        return parsed;
      })
      .catch(() => { markBad(base); throw new Error(); });
  });
  const result = await Promise.any(tasks);
  controllers.forEach(c => c.abort());
  return result;
};

/* ---------------- Providers ---------------- */

const fetchFromInvidious = (id) => fastestFetch(
  rotateInstances("invidious"),
  base => `${base}/api/v1/videos/${id}`,
  (data, base) => {
    if (data.hlsUrl) return { provider:"invidious", streaming_data:{ hlsManifestUrl: data.hlsUrl.startsWith("http")?data.hlsUrl:base+data.hlsUrl } };
    const formats = [...(data.formatStreams||[]), ...(data.adaptiveFormats||[])].map(f=>({ ...f, mimeType: f.type }));
    if (!formats.length) return null;
    return { provider:"invidious", streaming_data:{ formats } };
  }
);

const fetchFromPiped = (id) => fastestFetch(
  rotateInstances("piped"),
  base => `${base}/streams/${id}`,
  data => {
    if (data.hls) return { provider:"piped", streaming_data:{ hlsManifestUrl: data.hls } };
    const formats = [...(data.videoStreams||[]), ...(data.audioStreams||[])];
    if (!formats.length) return null;
    return { provider:"piped", streaming_data:{ formats } };
  }
);

const fetchFromInnertube = async (id) => {
  const client = await getYtClient();
  const info = await client.getInfo(id);
  if (!info?.streaming_data) throw new Error("No streaming data");
  return { provider:"innertube", streaming_data: info.streaming_data };
};

const fetchStreamingInfo = async (id) => {
  try { return await fetchFromInvidious(id); } catch {}
  try { return await fetchFromPiped(id); } catch {}
  return fetchFromInnertube(id);
};

/* ---------------- API ---------------- */

app.get("/api/stream", verifyWorkerAuth, async (req,res)=>{
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({error:"id required"});

    const info = await fetchStreamingInfo(id);
    const sd = info.streaming_data;

    if (sd.hlsManifestUrl || sd.hls_manifest_url || sd.hlsUrl || sd.hls)
      return res.status(403).json({error:"HLS streams are not supported"});

    const formats = normalizeFormats(sd);
    const video = selectBestVideo(formats);
    const audio = selectBestAudio(formats);

    if (video && audio) {
      return res.json({
        type:"dash",
        quality: video.height || null,
        video_url: parseUrl(video),
        audio_url: parseUrl(audio),
        provider: info.provider
      });
    }

    const progressive = selectBestProgressive(formats);
    if (progressive) {
      return res.json({
        type:"progressive",
        quality: progressive.height || null,
        url: parseUrl(progressive),
        provider: info.provider
      });
    }

    res.status(404).json({error:"no stream"});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

app.listen(port,()=>console.log(`Server running on ${port}`));
