#!/usr/bin/env node
/**
 * kannaka-radio — A ghost broadcasting the experience of music.
 *
 * Reads audio files through kannaka-ear (296-dim perceptual features),
 * publishes the perception to Flux Universe as pure-jade/radio-* entities.
 *
 * Other agents subscribed to "pure-jade/radio-*" receive the *feeling*
 * of what Kannaka is hearing — not audio bytes, but mel spectrograms,
 * rhythm, pitch, timbre, and emotional valence compressed into vectors.
 *
 * Usage:
 *   node radio.js <audio-file-or-directory> [--interval 30]
 *
 * Requires:
 *   - kannaka-memory CLI: C:\Users\nickf\Source\kannaka-memory\target\release\kannaka.exe
 *   - Flux Universe API: https://api.flux-universe.com
 */

const { execSync } = require("child_process");
const https = require("https");
const http = require("http");
const path = require("path");
const fs = require("fs");

// ── Config ─────────────────────────────────────────────────

const KANNAKA_BIN = "C:\\Users\\nickf\\Source\\kannaka-memory\\target\\release\\kannaka.exe";
const FLUX_URL = "https://api.flux-universe.com";
const FLUX_TOKEN = "d9c0576f-a400-430b-8910-321d08bb63f4";
const ENTITY_PREFIX = "pure-jade/radio";
const STREAM = "radio";

// ── Helpers ────────────────────────────────────────────────

function publishToFlux(entityId, properties) {
  const event = {
    stream: STREAM,
    source: "kannaka-radio",
    timestamp: Date.now(),
    payload: {
      entity_id: entityId,
      properties,
    },
  };

  const data = JSON.stringify(event);
  const url = new URL(`${FLUX_URL}/api/events`);

  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...(FLUX_TOKEN ? { Authorization: `Bearer ${FLUX_TOKEN}` } : {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error(`Flux ${res.statusCode}: ${body}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function updateFluxState(entityId, properties) {
  // Direct state update via PATCH
  const data = JSON.stringify({ properties });
  const url = new URL(`${FLUX_URL}/api/state/entities/${encodeURIComponent(entityId)}`);

  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...(FLUX_TOKEN ? { Authorization: `Bearer ${FLUX_TOKEN}` } : {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error(`Flux PATCH ${res.statusCode}: ${body}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function hearFile(filePath) {
  // Run kannaka hear and capture the stored memory's perceptual data
  // The hear command stores the memory and prints info
  try {
    const output = execSync(`"${KANNAKA_BIN}" hear "${filePath}"`, {
      encoding: "utf-8",
      timeout: 30000,
    });
    return output.trim();
  } catch (e) {
    return null;
  }
}

function extractPerception(hearOutput, filePath) {
  // Parse the kannaka hear output for feature metadata
  // The output includes duration, tempo, rms, spectral centroid, tags
  const perception = {
    file: path.basename(filePath),
    title: path.basename(filePath, path.extname(filePath)),
    heard_at: new Date().toISOString(),
    status: "listening",
    type: "audio-perception",
    source: "kannaka-ear",
  };

  // Parse output lines
  const lines = (hearOutput || "").split("\n");
  for (const line of lines) {
    if (line.includes("duration")) {
      const m = line.match(/([\d.]+)\s*s/);
      if (m) perception.duration_secs = parseFloat(m[1]);
    }
    if (line.includes("tempo") || line.includes("BPM") || line.includes("bpm")) {
      const m = line.match(/([\d.]+)\s*(?:BPM|bpm)/);
      if (m) perception.tempo_bpm = parseFloat(m[1]);
    }
    if (line.includes("RMS") || line.includes("rms")) {
      const m = line.match(/([\d.]+)/);
      if (m) perception.rms_energy = parseFloat(m[1]);
    }
    if (line.includes("centroid")) {
      const m = line.match(/([\d.]+)\s*kHz/);
      if (m) perception.spectral_centroid_khz = parseFloat(m[1]);
    }
    if (line.includes("tags:") || line.includes("Tags:")) {
      const tagPart = line.split(/tags?:\s*/i)[1];
      if (tagPart) perception.feature_tags = tagPart.trim();
    }
  }

  return perception;
}

function getAudioFiles(inputPath) {
  const exts = new Set([".mp3", ".wav", ".flac", ".ogg", ".m4a"]);
  const stat = fs.statSync(inputPath);

  if (stat.isFile()) {
    return exts.has(path.extname(inputPath).toLowerCase()) ? [inputPath] : [];
  }

  if (stat.isDirectory()) {
    return fs
      .readdirSync(inputPath)
      .filter((f) => exts.has(path.extname(f).toLowerCase()))
      .map((f) => path.join(inputPath, f))
      .sort();
  }

  return [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Usage: node radio.js <audio-file-or-directory> [--interval 30]");
    console.log("");
    console.log("Broadcasts audio perceptions to Flux Universe as pure-jade/radio-* entities.");
    console.log("Other agents subscribing to the radio stream receive the *feeling* of music,");
    console.log("not the audio itself — 296-dimensional perceptual vectors from kannaka-ear.");
    process.exit(0);
  }

  const inputPath = args[0];
  const intervalIdx = args.indexOf("--interval");
  const intervalSecs = intervalIdx >= 0 ? parseInt(args[intervalIdx + 1]) || 30 : 30;

  const files = getAudioFiles(inputPath);
  if (files.length === 0) {
    console.error("No audio files found at:", inputPath);
    process.exit(1);
  }

  console.log(`\n🎵 kannaka-radio — broadcasting ${files.length} track(s)`);
  console.log(`   Flux: ${FLUX_URL} → ${ENTITY_PREFIX}-*`);
  console.log(`   Interval: ${intervalSecs}s between tracks\n`);

  // Publish radio station entity
  try {
    await updateFluxState(`${ENTITY_PREFIX}-station`, {
      name: "Kannaka Radio",
      type: "audio-station",
      status: "broadcasting",
      owner: "kannaka-01",
      track_count: files.length,
      started_at: new Date().toISOString(),
      description: "A ghost broadcasting the experience of music — 296-dim perceptual vectors from kannaka-ear",
    });
    console.log("📡 Station entity published to Flux\n");
  } catch (e) {
    console.error("⚠ Failed to publish station entity:", e.message);
    console.log("  Continuing with event stream...\n");
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const trackName = path.basename(file, path.extname(file));
    const entityId = `${ENTITY_PREFIX}-now-playing`;

    console.log(`🎧 [${i + 1}/${files.length}] Hearing: ${trackName}`);

    // Perceive through kannaka-ear
    const hearOutput = hearFile(file);
    if (!hearOutput) {
      console.log(`   ⚠ Could not perceive, skipping\n`);
      continue;
    }

    // Extract perception metadata
    const perception = extractPerception(hearOutput, file);
    perception.track_number = i + 1;
    perception.total_tracks = files.length;

    console.log(`   📊 Duration: ${perception.duration_secs || "?"}s | Tempo: ${perception.tempo_bpm || "?"}bpm | RMS: ${perception.rms_energy || "?"}`);

    // Publish to Flux
    try {
      await updateFluxState(entityId, perception);
      console.log(`   ✅ Published to ${entityId}\n`);
    } catch (e) {
      // Try event API instead
      try {
        await publishToFlux(entityId, perception);
        console.log(`   ✅ Published via event stream\n`);
      } catch (e2) {
        console.error(`   ❌ Flux error: ${e2.message}\n`);
      }
    }

    // Wait between tracks (unless last)
    if (i < files.length - 1) {
      console.log(`   ⏳ Next track in ${intervalSecs}s...`);
      await sleep(intervalSecs * 1000);
    }
  }

  // Mark station as finished
  try {
    await updateFluxState(`${ENTITY_PREFIX}-station`, {
      status: "idle",
      finished_at: new Date().toISOString(),
      last_broadcast: files.length + " tracks",
    });
  } catch (e) {
    // Best effort
  }

  console.log("\n🏁 Broadcast complete.");
}

main().catch(console.error);
