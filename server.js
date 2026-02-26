import express from "express";
import { Innertube } from "youtubei.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { PassThrough, Readable } from "stream";

const app = express();
const port = process.env.PORT || 3000;

const CACHE_DIR = path.resolve(process.cwd(), "cache");
const MAX_CACHE_BYTES = 5 * 1024 * 1024 * 1024;
const FORWARD_HEADER_KEYS = new Set([
  "content-type",
  "content-length",
  "accept-ranges",
  "content-range",
  "content-disposition",
  "cache-control",
  "etag",
  "last-modified"
]);

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

let ytPromise = Innertube.create({ client_type: "ANDROID", generate_session_locally: true });
let ytClient;

async function getYtClient() {
  if (!ytClient) ytClient = await ytPromise;
  return ytClient;
}

function sha1Key(id, itag) {
  return crypto.createHash("sha1").update(`${id}:${itag}`).digest("hex");
}

function filePathForKey(key) {
  return path.join(CACHE_DIR, key);
}

function tmpPathForKey(key) {
  return `${filePathForKey(key)}.tmp`;
}

function parseSignatureUrl(format) {
  if (!format) return null;
  if (format.url) return format.url;
  const sc = format.signatureCipher || format.signature_cipher || format.cipher || format.signatureCipher;
  if (!sc) return null;
  try {
    const params = new URLSearchParams(sc);
    const u = params.get("url") || params.get("u");
    if (!u) return null;
    return decodeURIComponent(u);
  } catch (e) {
    return null;
  }
}

async function fetchStreamingInfo(id) {
  const client = await getYtClient();
  try {
    const info = await client.getInfo(id);
    if (info && info.streaming_data) return { streaming_data: info.streaming_data };
  } catch (e) {
    console.error("getInfo error:", e?.message || e);
  }
  try {
    const sd = await client.getStreamingData(id);
    if (sd) {
      const streaming_data = sd.formats || sd.adaptive_formats ? sd : { formats: Array.isArray(sd) ? sd : [sd], adaptive_formats: [] };
      return { streaming_data };
    }
  } catch (e) {
    console.error("getStreamingData error:", e?.message || e);
  }
  throw new Error("streaming data unavailable");
}

function parseRangeHeader(rangeHeader, size) {
  if (!rangeHeader) return null;
  const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!m) return null;
  let start = m[1] === "" ? null : parseInt(m[1], 10);
  let end = m[2] === "" ? null : parseInt(m[2], 10);
  if (start === null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null) {
    end = size - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= size) return null;
  return { start, end };
}

async function enforceCacheLimit() {
  try {
    const files = fs.readdirSync(CACHE_DIR)
      .filter(f => !f.endsWith(".tmp"))
      .map(f => {
        const p = path.join(CACHE_DIR, f);
        const s = fs.statSync(p);
        return { path: p, mtime: s.mtimeMs, size: s.size };
      })
      .sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((acc, f) => acc + f.size, 0);
    if (total <= MAX_CACHE_BYTES) return;
    for (const f of files) {
      try {
        fs.unlinkSync(f.path);
        total -= f.size;
        if (total <= MAX_CACHE_BYTES) break;
      } catch (e) {
        console.error("prune error:", e);
      }
    }
  } catch (e) {
    console.error("enforceCacheLimit error:", e);
  }
}

const inProgress = new Map();

async function backgroundDownloadIfAbsent(key, url) {
  if (inProgress.has(key)) return;
  const tmpPath = tmpPathForKey(key);
  const finalPath = filePathForKey(key);
  const entry = {
    pass: new PassThrough(),
    tmpPath,
    finalPath,
    headers: null,
    status: null,
    ready: null,
    resolve: null,
    reject: null,
    clients: new Set()
  };
  let resolveFn, rejectFn;
  entry.ready = new Promise((r, j) => { resolveFn = r; rejectFn = j; });
  entry.resolve = resolveFn;
  entry.reject = rejectFn;
  inProgress.set(key, entry);
  try {
    const resp = await fetch(url);
    if (!resp.body) {
      entry.reject(new Error("no body"));
      inProgress.delete(key);
      return;
    }
    const ws = fs.createWriteStream(tmpPath);
    const stream = typeof resp.body.pipe === "function" ? resp.body : Readable.fromWeb(resp.body);
    stream.pipe(entry.pass);
    stream.pipe(ws);
    await Promise.all([
      new Promise((r, j) => { stream.on("end", r); stream.on("error", j); }),
      new Promise((r, j) => { ws.on("finish", r); ws.on("error", j); })
    ]);
    try { ws.end(); } catch (e) {}
    if (fs.existsSync(tmpPath)) {
      try { fs.renameSync(tmpPath, finalPath); } catch (e) { console.error("rename error:", e); }
      entry.resolve();
      inProgress.delete(key);
      await enforceCacheLimit();
    } else {
      entry.reject(new Error("tmp missing"));
      inProgress.delete(key);
    }
  } catch (e) {
    entry.reject(e);
    inProgress.delete(key);
    console.error("backgroundDownload error:", e);
  }
}

app.get("/api/stream", async (req, res) => {
  try {
    const id = req.query.id;
    let itag = req.query.itag ? Number(req.query.itag) : null;
    if (!id) return res.status(400).json({ error: "id required" });
    const info = await fetchStreamingInfo(id);
    const sd = info.streaming_data || {};
    const formats = [...(sd.formats || []), ...(sd.adaptive_formats || [])].filter(Boolean);
    if (!formats.length) return res.status(404).json({ error: "no formats" });
    if (!itag) {
      const progressive = formats.find(f => (f.mime_type || f.mimeType || "").includes("video") && (f.audio_quality || f.audioBitrate || f.mime_type?.includes("audio") || f.has_audio));
      const nonDash = formats.find(f => f.itag === 22) || formats.find(f => f.itag === 18);
      if (nonDash) itag = nonDash.itag;
      else if (progressive) itag = progressive.itag;
      else {
        const dashVideo = formats.find(f => f.mime_type && f.mime_type.includes("video")) || formats[0];
        itag = dashVideo.itag;
      }
    }
    const format = formats.find(f => f.itag === itag);
    if (!format) return res.status(404).json({ error: "itag not found" });
    const url = parseSignatureUrl(format);
    const range = req.headers.range;
    const key = sha1Key(id, format.itag);
    const finalPath = filePathForKey(key);
    const tmpPath = tmpPathForKey(key);
    if (fs.existsSync(finalPath)) {
      const stat = fs.statSync(finalPath);
      const size = stat.size;
      res.setHeader("Accept-Ranges", "bytes");
      const contentType = (format.mime_type || format.mimeType || "").split(";")[0] || "application/octet-stream";
      res.setHeader("Content-Type", contentType);
      if (range) {
        const r = parseRangeHeader(range, size);
        if (!r) return res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
        const { start, end } = r;
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
        res.setHeader("Content-Length", String(end - start + 1));
        const stream = fs.createReadStream(finalPath, { start, end });
        stream.pipe(res);
        return;
      } else {
        res.setHeader("Content-Length", String(size));
        const stream = fs.createReadStream(finalPath);
        stream.pipe(res);
        return;
      }
    }
    if (!url) return res.status(422).json({ error: "format has no direct url" });
    if (range) {
      try {
        const upstreamHeaders = { Range: range };
        const upstream = await fetch(url, { headers: upstreamHeaders });
        res.status(upstream.status);
        const forwardHeaders = {};
        for (const [k, v] of upstream.headers) {
          try {
            const lk = k.toLowerCase();
            if (FORWARD_HEADER_KEYS.has(lk)) {
              forwardHeaders[lk] = v;
              res.setHeader(lk, v);
            }
          } catch (e) {}
        }
        if (!upstream.body) return res.status(502).json({ error: "no upstream body" });
        const upstreamStream = typeof upstream.body.pipe === "function" ? upstream.body : Readable.fromWeb(upstream.body);
        upstreamStream.on("error", () => { try { res.destroy(); } catch (e) {} });
        upstreamStream.pipe(res);
        backgroundDownloadIfAbsent(key, url).catch(e => console.error("bg start error:", e));
        return;
      } catch (e) {
        console.error("range fetch error:", e);
        return res.status(502).json({ error: "upstream error" });
      }
    }
    const ongoing = inProgress.get(key);
    if (ongoing) {
      try {
        res.status(ongoing.status || 200);
        for (const [k, v] of Object.entries(ongoing.headers || {})) {
          try { res.setHeader(k, v); } catch (e) {}
        }
        ongoing.clients.add(res);
        ongoing.pass.pipe(res);
        const onClose = () => {
          ongoing.clients.delete(res);
          try { ongoing.pass.unpipe(res); } catch (e) {}
        };
        res.once("close", onClose);
        res.once("finish", onClose);
        return;
      } catch (e) {
        console.error("attach error:", e);
      }
    }
    const entry = {
      pass: new PassThrough(),
      tmpPath,
      finalPath,
      headers: null,
      status: null,
      ready: null,
      resolve: null,
      reject: null,
      clients: new Set()
    };
    let resolveEntry, rejectEntry;
    entry.ready = new Promise((r, j) => { resolveEntry = r; rejectEntry = j; });
    entry.resolve = resolveEntry;
    entry.reject = rejectEntry;
    inProgress.set(key, entry);
    try {
      const upstream = await fetch(url);
      if (!upstream.body) {
        entry.reject(new Error("no body"));
        inProgress.delete(key);
        return res.status(502).json({ error: "no upstream body" });
      }
      const headersObj = {};
      for (const [k, v] of upstream.headers) {
        try {
          const lk = k.toLowerCase();
          if (FORWARD_HEADER_KEYS.has(lk)) headersObj[lk] = v;
        } catch (e) {}
      }
      entry.headers = headersObj;
      entry.status = upstream.status;
      const writeStream = fs.createWriteStream(tmpPath);
      res.status(upstream.status);
      for (const [k, v] of Object.entries(headersObj)) {
        try { res.setHeader(k, v); } catch (e) {}
      }
      entry.clients.add(res);
      const stream = typeof upstream.body.pipe === "function" ? upstream.body : Readable.fromWeb(upstream.body);
      stream.pipe(entry.pass);
      entry.pass.pipe(res);
      stream.pipe(writeStream);
      const onClientClose = () => {
        entry.clients.delete(res);
        try { entry.pass.unpipe(res); } catch (e) {}
      };
      res.once("close", onClientClose);
      res.once("finish", onClientClose);
      await Promise.all([
        new Promise((r, j) => { stream.on("end", r); stream.on("error", j); }),
        new Promise((r, j) => { writeStream.on("finish", r); writeStream.on("error", j); })
      ]);
      try { writeStream.end(); } catch (e) {}
      if (fs.existsSync(tmpPath)) {
        try { fs.renameSync(tmpPath, finalPath); } catch (e) { console.error("rename error:", e); }
        entry.resolve();
        inProgress.delete(key);
        await enforceCacheLimit();
      } else {
        entry.reject(new Error("tmp missing"));
        inProgress.delete(key);
      }
      return;
    } catch (e) {
      console.error("full fetch error:", e);
      try { entry.reject(e); } catch (_) {}
      inProgress.delete(key);
      return res.status(500).json({ error: String(e?.message || e) });
    }
  } catch (e) {
    try { res.status(500).json({ error: String(e?.message || e) }); } catch {}
  }
});

app.listen(port, () => {
  console.log(`Server listening on ${port}`);
});