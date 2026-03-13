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

const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.f5.si",
  "https://invidious.lunivers.trade",
  "https://iv.melmac.space",
  "https://yt.omada.cafe",
  "https://invidious.nerdvpn.de",
  "https://invidious.tiekoetter.com",
  "https://yewtu.be",
];

const PIPED_INSTANCES = [
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
];

let ytPromise = Innertube.create({
  client_type: "ANDROID",
  generate_session_locally: true
});

let ytClient;

async function getYtClient() {
  if (!ytClient) ytClient = await ytPromise;
  return ytClient;
}

const badInstances = new Map();
const nextIndex = { invidious: 0, piped: 0 };

function markBad(i) {
  badInstances.set(i, Date.now());
}

function isBad(i) {
  const t = badInstances.get(i);
  if (!t) return false;

  if (Date.now() - t > INSTANCE_BAN_MS) {
    badInstances.delete(i);
    return false;
  }

  return true;
}

function getInstancesForProvider(list, key) {
  const idx = nextIndex[key] % list.length;
  nextIndex[key] = (idx + 1) % list.length;

  const rotated = [...list.slice(idx), ...list.slice(0, idx)];

  const good = rotated.filter(i => !isBad(i));

  return good.length ? good : rotated;
}

function parseSignatureUrl(format) {
  if (format.url) return format.url;

  const sc =
    format.signatureCipher ||
    format.signature_cipher ||
    format.cipher;

  if (!sc) return null;

  try {
    const params = new URLSearchParams(sc);
    return params.get("url");
  } catch {
    return null;
  }
}

function selectBestProgressive(formats) {
  const combined = formats
    .map(f => ({
      f,
      url: parseSignatureUrl(f),
      height: Number(f.height || 0),
      bitrate: Number(f.bitrate || 0),
      mime: (f.mimeType || f.mime_type || "").toLowerCase(),
      has_audio: /mp4a|opus|aac/.test(f.mimeType || "")
    }))
    .filter(x => x.url && x.has_audio && /video/.test(x.mime));

  if (!combined.length) return null;

  combined.sort((a,b)=>b.height-a.height || b.bitrate-a.bitrate);

  return combined[0].f;
}

function selectBestVideo(formats) {
  const vids = formats
    .filter(f => /video/.test(f.mimeType || ""))
    .sort((a,b)=> (b.height||0)-(a.height||0));

  return vids[0] || null;
}

function selectBestAudio(formats) {
  const aud = formats
    .filter(f => /audio/.test(f.mimeType || ""))
    .sort((a,b)=> (b.bitrate||0)-(a.bitrate||0));

  return aud[0] || null;
}

async function fastestInstanceFetch(instances, buildUrl, parser) {
  const controllers = [];

  const tasks = instances.map(async base => {
    const controller = new AbortController();
    controllers.push(controller);

    try {
      const resp = await fetch(buildUrl(base), {
        signal: controller.signal
      });

      if (!resp.ok) {
        markBad(base);
        throw new Error();
      }

      const data = await resp.json();
      const parsed = parser(data);

      if (!parsed) throw new Error();

      return parsed;

    } catch {
      markBad(base);
      throw new Error();
    }
  });

  const result = await Promise.any(tasks);

  controllers.forEach(c => c.abort());

  return result;
}

async function fetchFromInvidious(id) {
  const instances = getInstancesForProvider(
    INVIDIOUS_INSTANCES,
    "invidious"
  );

  return fastestInstanceFetch(
    instances,
    base => `${base}/api/v1/videos/${id}`,
    data => {

      const formats = [];

      if (data.formatStreams)
        for (const f of data.formatStreams)
          formats.push({...f,mimeType:f.type});

      if (data.adaptiveFormats)
        for (const f of data.adaptiveFormats)
          formats.push({...f,mimeType:f.type});

      return formats.length
        ? {provider:"invidious", streaming_data:{formats}}
        : null;
    }
  );
}

async function fetchFromPiped(id) {
  const instances = getInstancesForProvider(
    PIPED_INSTANCES,
    "piped"
  );

  return fastestInstanceFetch(
    instances,
    base => `${base}/streams/${id}`,
    data => {

      const formats = [];

      if (data.videoStreams)
        for (const v of data.videoStreams)
          formats.push({...v,mimeType:v.mimeType});

      if (data.audioStreams)
        for (const a of data.audioStreams)
          formats.push({...a,mimeType:a.mimeType});

      return formats.length
        ? {provider:"piped", streaming_data:{formats}}
        : null;
    }
  );
}

async function fetchFromInnertube(id) {
  const client = await getYtClient();

  const info = await client.getInfo(id);

  if (!info?.streaming_data)
    throw new Error("no streaming");

  return {
    provider:"innertube",
    streaming_data:info.streaming_data
  };
}

async function fetchStreamingInfo(id) {
  try { return await fetchFromInvidious(id); } catch {}
  try { return await fetchFromPiped(id); } catch {}
  return fetchFromInnertube(id);
}

function timingSafeEqualHex(a,b){
  const A=Buffer.from(a,"hex");
  const B=Buffer.from(b,"hex");
  if(A.length!==B.length) return false;
  return crypto.timingSafeEqual(A,B);
}

function verifyWorkerAuth(req,res,next){

  const ts=req.header("x-proxy-timestamp");
  const sig=req.header("x-proxy-signature");

  if(!ts||!sig) return res.status(401).json({error:"unauthorized"});

  const now=Math.floor(Date.now()/1000);

  if(Math.abs(now-Number(ts))>ALLOWED_WINDOW)
    return res.status(401).json({error:"unauthorized"});

  const payload=`${ts}:${req.originalUrl}`;

  const expected=crypto
    .createHmac("sha256",WORKER_SECRET)
    .update(payload)
    .digest("hex");

  if(!timingSafeEqualHex(expected,sig))
    return res.status(401).json({error:"unauthorized"});

  next();
}

app.get("/api/stream",verifyWorkerAuth,async(req,res)=>{

  try{

    const id=req.query.id;

    if(!id) return res.status(400).json({error:"id required"});

    const info=await fetchStreamingInfo(id);

    const sd=info.streaming_data;

    if(sd.hlsManifestUrl||sd.hls_manifest_url){

      return res.json({
        type:"live",
        url:sd.hlsManifestUrl||sd.hls_manifest_url,
        provider:info.provider
      });

    }

    const formats=[
      ...(sd.formats||[]),
      ...(sd.adaptive_formats||[])
    ];

    const progressive=selectBestProgressive(formats);

    if(progressive){

      return res.json({
        type:"progressive",
        url:parseSignatureUrl(progressive),
        itag:progressive.itag,
        provider:info.provider
      });

    }

    const video=selectBestVideo(formats);
    const audio=selectBestAudio(formats);

    if(video&&audio){

      return res.json({
        type:"dash",
        video_url:parseSignatureUrl(video),
        audio_url:parseSignatureUrl(audio),
        video_itag:video.itag,
        audio_itag:audio.itag,
        provider:info.provider
      });

    }

    return res.status(404).json({error:"no stream"});

  }catch(e){

    return res.status(500).json({error:e.message});

  }

});

app.listen(port,()=>{
  console.log("Server running on",port);
});
