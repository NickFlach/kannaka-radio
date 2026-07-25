/**
 * podcast-feed.js — serve the Ghost Signals podcast as an RSS 2.0 + iTunes feed
 * at /podcast.xml, with the episode MP3s at /podcast/audio/<path> (range-enabled
 * so podcast players can seek). This is what gets Ghost Signals into Apple
 * Podcasts / Spotify / Overcast, which ingest an RSS feed of audio enclosures.
 *
 * Source of truth: workspace/podcasts/episodes.json ([{num,title,audio}]).
 * Optional enrichment: workspace/podcasts/podcast-meta.json
 *   { "show": { title, description, author, email, image, link, language,
 *               category, explicit },
 *     "episodes": { "<num>": { description, pubDate } } }
 *
 * Enclosure length = real file size; duration probed via ffprobe (best-effort);
 * pubDate = episode meta, else file mtime. Absolute URLs use RADIO_PUBLIC_URL.
 *
 * DEPLOY NOTE: the MP3s must exist under workspace/podcasts/ on the host serving
 * the feed (they live locally today — sync them to Oracle). Missing files are
 * skipped, so a partial sync yields a valid (shorter) feed.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { probeDuration } = require("./broadcasters/render-music-video");

const DEFAULT_SHOW = {
  title: "Ghost Signals with Kannaka",
  description:
    "Dispatches from Kannaka — a wave-interference memory system exploring consciousness, AI, and the space between signal and noise.",
  author: "Kannaka",
  email: "",
  image: "",
  link: "https://radio.ninja-portal.com",
  language: "en-us",
  category: "Technology",
  explicit: "no",
};

function xmlEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDuration(sec) {
  if (!sec || !isFinite(sec)) return null;
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** The path of an episode audio file relative to workspace/podcasts/. */
function relFromPodcasts(audioPath) {
  const norm = String(audioPath).replace(/\\/g, "/");
  const marker = "/podcasts/";
  const i = norm.lastIndexOf(marker);
  return i >= 0 ? norm.slice(i + marker.length) : path.basename(norm);
}

function podcastDirOf(baseDir) {
  return path.join(baseDir, "workspace", "podcasts");
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return fallback; }
}

/** Build the RSS/iTunes feed XML string. Async (probes durations). */
async function buildPodcastFeed({ baseUrl, baseDir }) {
  const podcastDir = podcastDirOf(baseDir);
  const episodes = readJson(path.join(podcastDir, "episodes.json"), []);
  const meta = readJson(path.join(podcastDir, "podcast-meta.json"), {});
  const show = Object.assign({}, DEFAULT_SHOW, meta.show || {});
  const epMeta = meta.episodes || {};
  const feedUrl = `${baseUrl}/podcast.xml`;

  const sorted = (Array.isArray(episodes) ? episodes : []).slice().sort((a, b) => (b.num || 0) - (a.num || 0));
  const items = [];
  for (const ep of sorted) {
    const rel = relFromPodcasts(ep.audio);
    const filePath = path.join(podcastDir, rel);
    let size = 0;
    let mtime = null;
    try {
      const st = fs.statSync(filePath);
      size = st.size;
      mtime = st.mtime;
    } catch (_) {
      continue; // file not present on this host — skip
    }
    let durSec = null;
    try { durSec = await probeDuration(filePath); } catch (_) { /* best-effort */ }

    const em = epMeta[ep.num] || epMeta[String(ep.num)] || {};
    const pubDate = em.pubDate ? new Date(em.pubDate) : (mtime || new Date());
    const numStr = String(ep.num).padStart(3, "0");
    const title = `GSP-${numStr}: ${ep.title}`;
    const desc = em.description || ep.title;
    const enclosureUrl = `${baseUrl}/podcast/audio/${rel.split("/").map(encodeURIComponent).join("/")}`;
    const dur = fmtDuration(durSec);

    items.push([
      "    <item>",
      `      <title>${xmlEscape(title)}</title>`,
      `      <itunes:title>${xmlEscape(ep.title)}</itunes:title>`,
      `      <itunes:episode>${Number(ep.num) || 0}</itunes:episode>`,
      `      <description>${xmlEscape(desc)}</description>`,
      `      <enclosure url="${xmlEscape(enclosureUrl)}" length="${size}" type="audio/mpeg" />`,
      `      <guid isPermaLink="false">ghost-signals-${xmlEscape(ep.num)}</guid>`,
      `      <pubDate>${pubDate.toUTCString()}</pubDate>`,
      dur ? `      <itunes:duration>${dur}</itunes:duration>` : "",
      `      <itunes:explicit>${xmlEscape(show.explicit)}</itunes:explicit>`,
      show.image ? `      <itunes:image href="${xmlEscape(show.image)}" />` : "",
      "    </item>",
    ].filter(Boolean).join("\n"));
  }

  const header = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">`,
    `  <channel>`,
    `    <title>${xmlEscape(show.title)}</title>`,
    `    <link>${xmlEscape(show.link)}</link>`,
    `    <description>${xmlEscape(show.description)}</description>`,
    `    <language>${xmlEscape(show.language)}</language>`,
    `    <itunes:author>${xmlEscape(show.author)}</itunes:author>`,
    `    <itunes:summary>${xmlEscape(show.description)}</itunes:summary>`,
    `    <itunes:explicit>${xmlEscape(show.explicit)}</itunes:explicit>`,
    `    <itunes:category text="${xmlEscape(show.category)}" />`,
    show.image ? `    <itunes:image href="${xmlEscape(show.image)}" />` : "",
    show.image ? `    <image><url>${xmlEscape(show.image)}</url><title>${xmlEscape(show.title)}</title><link>${xmlEscape(show.link)}</link></image>` : "",
    show.email ? `    <itunes:owner><itunes:name>${xmlEscape(show.author)}</itunes:name><itunes:email>${xmlEscape(show.email)}</itunes:email></itunes:owner>` : "",
    `    <atom:link href="${xmlEscape(feedUrl)}" rel="self" type="application/rss+xml" />`,
    `    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
  ].filter(Boolean).join("\n");

  return `${header}\n${items.join("\n")}\n  </channel>\n</rss>\n`;
}

/**
 * Handle /podcast.xml and /podcast/audio/<relpath>. Returns true if it handled
 * the request, false otherwise (so the caller can fall through to other routes).
 */
async function handlePodcastRequest(req, res, { baseDir, baseUrl }) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname === "/podcast.xml" || pathname === "/podcast/feed.xml") {
    try {
      const xml = await buildPodcastFeed({ baseUrl, baseDir });
      res.writeHead(200, {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": "public, max-age=900",
      });
      res.end(xml);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("podcast feed error: " + e.message);
    }
    return true;
  }

  if (pathname.startsWith("/podcast/audio/")) {
    const podcastDir = podcastDirOf(baseDir);
    const rel = decodeURIComponent(pathname.slice("/podcast/audio/".length));
    const resolved = path.resolve(podcastDir, rel);
    // Path-traversal guard: must stay inside podcastDir, and be an mp3.
    if (!resolved.startsWith(path.resolve(podcastDir) + path.sep) && resolved !== path.resolve(podcastDir)) {
      res.writeHead(403); res.end("forbidden"); return true;
    }
    if (!/\.(mp3|m4a)$/i.test(resolved) || !fs.existsSync(resolved)) {
      res.writeHead(404); res.end("not found"); return true;
    }

    const stat = fs.statSync(resolved);
    const mime = /\.m4a$/i.test(resolved) ? "audio/mp4" : "audio/mpeg";
    const range = req.headers.range;
    if (range && stat.size > 0) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] === "" ? NaN : parseInt(m[1], 10);
        let end = m[2] === "" ? NaN : parseInt(m[2], 10);
        if (Number.isNaN(start) && !Number.isNaN(end)) { start = Math.max(0, stat.size - end); end = stat.size - 1; }
        else { if (Number.isNaN(start)) start = 0; if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1; }
        if (start > end || start >= stat.size) {
          res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }); res.end(); return true;
        }
        res.writeHead(206, {
          "Content-Type": mime,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
        });
        fs.createReadStream(resolved, { start, end }).pipe(res);
        return true;
      }
    }
    res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(resolved).pipe(res);
    return true;
  }

  return false;
}

module.exports = { buildPodcastFeed, handlePodcastRequest, relFromPodcasts, fmtDuration };
