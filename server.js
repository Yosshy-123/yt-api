import express from "express";
import fetch from "node-fetch";
import { Innertube } from "youtubei.js";

const app = express();
const port = process.env.PORT || 3000;

let yt;

(async () => {
  yt = await Innertube.create();
})();

app.get("/api/stream", async (req, res) => {
  try {
    const id = req.query.id;
    let itag = req.query.itag ? Number(req.query.itag) : null;

    if (!id) {
      return res.status(400).json({ error: "id required" });
    }

    const info = await yt.getInfo(id);
    const sd = info.streaming_data;
    const formats = [...(sd.formats || []), ...(sd.adaptive_formats || [])];

    if (!itag) {
      const nonDash = formats.find(f => f.itag === 22) || formats.find(f => f.itag === 18);
      if (nonDash) itag = nonDash.itag;
      else {
        const dashVideo = formats.find(f => f.mime_type.includes("video"));
        if (dashVideo) itag = dashVideo.itag;
        else itag = formats[0].itag;
      }
    }

    const format = formats.find(f => f.itag === itag);
    if (!format) {
      return res.status(404).json({ error: "itag not found" });
    }

    const url = format.url;
    const range = req.headers.range;
    const headers = {};
    if (range) headers.Range = range;

    const gvRes = await fetch(url, { headers });

    res.status(gvRes.status);
    gvRes.headers.forEach((v, k) => res.setHeader(k, v));
    gvRes.body.pipe(res);
  } catch (e) {
    res.status(500).json({ error: "proxy error" });
  }
});

app.listen(port);
