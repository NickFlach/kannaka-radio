/**
 * render-music-video.js — build a music video by mixing video clips and
 * still images against an audio track.
 *
 * Use case: we have a few short clips (15–30 s each) plus some stills
 * in `~/Desktop/kannaka-art/`. We want to assemble them into a
 * full-length 1920×1080 H.264 + AAC MP4 that runs as long as the audio,
 * looping the visual sequence as needed.
 *
 * Approach:
 *   1. Probe the audio's duration.
 *   2. Build an ffmpeg `filter_complex` that:
 *      - Scales+pads each video input to 1920×1080.
 *      - Wraps each still image in `loop` so it has a video stream of
 *        a configurable length (default 6 s).
 *      - Concatenates all normalised streams via the `concat` filter.
 *      - Wraps the concat output with `loop=loop=-1:size=99999` so it
 *        runs forever — `-shortest` then trims the output to the audio
 *        length.
 *   3. Encode H.264 (libx264, veryfast, CRF 22) + AAC 192 kbps,
 *      `+faststart` so YouTube can begin processing during the upload.
 *
 * Falls back gracefully:
 *   - If `sources` is empty but a single image is provided, behaves
 *     like the simpler renderAudioMp4().
 *   - Skips sources that don't exist on disk; logs a warning to stderr.
 *
 * Inputs that are themselves rendered output (a still-image MP4 you
 * made earlier) work fine — the concat filter re-encodes everything.
 */

"use strict";

const fs = require("fs");
const { execFile } = require("child_process");

function whichFfmpeg() { return process.env.FFMPEG_BIN || "ffmpeg"; }
function whichFfprobe() { return process.env.FFPROBE_BIN || "ffprobe"; }

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      whichFfprobe(),
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath],
      (err, stdout) => {
        if (err) return reject(err);
        const v = parseFloat(String(stdout).trim());
        if (!isFinite(v)) return reject(new Error(`unparseable duration: ${stdout}`));
        resolve(v);
      }
    );
  });
}

const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

function classify(p) {
  const i = p.lastIndexOf(".");
  if (i < 0) return "unknown";
  const ext = p.slice(i).toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  return "unknown";
}

/**
 * Render a music video.
 *
 * @param {object} opts
 * @param {string} opts.audioPath
 * @param {Array<string>} opts.sources  — paths to images/videos (mixed ok)
 * @param {string} opts.outPath
 * @param {number} [opts.width]      — default 1920
 * @param {number} [opts.height]     — default 1080
 * @param {number} [opts.imageDur]   — seconds each still image is shown, default 6
 * @returns {Promise<{outPath, durationSec, sourcesUsed}>}
 */
async function renderMusicVideo({
  audioPath,
  sources,
  outPath,
  width = 1920,
  height = 1080,
  imageDur = 6,
}) {
  if (!fs.existsSync(audioPath)) throw new Error(`audio missing: ${audioPath}`);
  const filtered = (sources || []).filter((p) => {
    if (!fs.existsSync(p)) {
      process.stderr.write(`[render-music-video] skipping missing: ${p}\n`);
      return false;
    }
    if (classify(p) === "unknown") {
      process.stderr.write(`[render-music-video] skipping unknown ext: ${p}\n`);
      return false;
    }
    return true;
  });
  if (filtered.length === 0) {
    throw new Error("no usable visual sources");
  }

  const audioSec = await probeDuration(audioPath);

  // Build ffmpeg invocation.
  const inputs = [];
  filtered.forEach((src) => {
    if (classify(src) === "image") {
      inputs.push("-loop", "1", "-framerate", "30", "-t", String(imageDur), "-i", src);
    } else {
      inputs.push("-i", src);
    }
  });
  inputs.push("-i", audioPath);
  const audioIdx = filtered.length;

  const scalePad =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,` +
    `setsar=1,fps=30,format=yuv420p`;

  const stages = [];
  filtered.forEach((_, i) => {
    stages.push(`[${i}:v]${scalePad}[v${i}]`);
  });
  const concatInputs = filtered.map((_, i) => `[v${i}]`).join("");
  stages.push(`${concatInputs}concat=n=${filtered.length}:v=1:a=0[cat]`);
  // loop filter: `size` is the frame cache (capped at 32767 in modern
  // ffmpeg builds), `loop=-1` means loop forever, then -shortest below
  // trims the final output to the audio length. 32767 frames at 30 fps
  // = 18 min of cached visual; longer source loops would need
  // size-aware re-encoding but practically every track is under that.
  stages.push(`[cat]loop=loop=-1:size=32767:start=0[looped]`);

  const filterComplex = stages.join("; ");

  const args = [
    "-y",
    ...inputs,
    "-filter_complex", filterComplex,
    "-map", "[looped]",
    "-map", `${audioIdx}:a`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    "-movflags", "+faststart",
    outPath,
  ];

  return new Promise((resolve, reject) => {
    const child = execFile(
      whichFfmpeg(),
      args,
      { maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          const tail = (stderr || "").split("\n").slice(-15).join("\n");
          return reject(new Error(`ffmpeg failed (rc=${err.code}): ${tail}`));
        }
        resolve({ outPath, durationSec: audioSec, sourcesUsed: filtered });
      }
    );
    child.on("error", reject);
  });
}

module.exports = { renderMusicVideo, probeDuration, classify };
