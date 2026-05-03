/**
 * render-audio-mp4.js — convert an audio file + a still image into a
 * YouTube-compatible MP4 via ffmpeg.
 *
 * Why we need this: the YouTube upload endpoint takes video, not audio.
 * For tracks (which are inherently audio-only) we render a static-image
 * "music video" — image is held for the duration of the audio, audio is
 * AAC-encoded into an MP4 container. This is the standard "lyric video"
 * trick used by indie labels and works fine on the platform (1080p,
 * H.264, AAC, faststart).
 *
 * Constraints / inputs:
 *   - audioPath: any ffmpeg-readable audio (mp3, wav, m4a, etc).
 *   - imagePath: any ffmpeg-readable still image. Will be scaled to
 *     1920x1080 with letterbox padding so portrait images don't crop.
 *   - outPath: target .mp4 path. Overwritten if exists.
 *
 * Output: a single H.264/AAC MP4 with `+faststart` so YouTube's
 * upload pipeline can start processing immediately.
 *
 * Skip if ffmpeg isn't installed: throws a clear error so the caller
 * can fall back to text-only broadcasting.
 */

"use strict";

const fs = require("fs");
const { execFile } = require("child_process");

function whichFfmpeg() {
  // Caller can override via env. Otherwise rely on PATH.
  return process.env.FFMPEG_BIN || "ffmpeg";
}

/**
 * Render a still-image music video.
 *
 * @param {object} opts
 * @param {string} opts.audioPath
 * @param {string} opts.imagePath
 * @param {string} opts.outPath
 * @param {number} [opts.width]   — default 1920
 * @param {number} [opts.height]  — default 1080
 * @returns {Promise<{outPath: string, durationSec: number}>}
 */
function renderAudioMp4({ audioPath, imagePath, outPath, width = 1920, height = 1080 }) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(audioPath)) return reject(new Error(`audio missing: ${audioPath}`));
    if (!fs.existsSync(imagePath)) return reject(new Error(`image missing: ${imagePath}`));

    // ffmpeg flag breakdown:
    //   -loop 1 -framerate 1   — synthesize a video stream from the still image
    //   -i image -i audio      — image first, then audio
    //   -c:v libx264 -tune stillimage -crf 22 -pix_fmt yuv420p
    //                          — small file (no per-frame change to encode)
    //   -c:a aac -b:a 192k     — clean stereo at 192 kbps
    //   -shortest              — end when audio ends (otherwise loops forever)
    //   -movflags +faststart   — moov atom at the front for streamable MP4
    //   -vf scale=...:force_original_aspect_ratio=decrease,pad=...:black
    //                          — letterbox the image to 1920x1080 without cropping
    const filter =
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,` +
      `format=yuv420p`;
    const args = [
      "-y",
      "-loop", "1",
      "-framerate", "1",
      "-i", imagePath,
      "-i", audioPath,
      "-vf", filter,
      "-c:v", "libx264",
      "-tune", "stillimage",
      "-crf", "22",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-movflags", "+faststart",
      outPath,
    ];

    const child = execFile(whichFfmpeg(), args, { maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const tail = (stderr || "").split("\n").slice(-12).join("\n");
        return reject(new Error(`ffmpeg failed (rc=${err.code}): ${tail}`));
      }
      // Pull duration from the audio probe ffmpeg embeds in stderr; fallback
      // to file-stat heuristic if it's not there.
      let durationSec = 0;
      const m = (stderr || "").match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) {
        durationSec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
      }
      resolve({ outPath, durationSec });
    });
    child.on("error", reject);
  });
}

module.exports = { renderAudioMp4 };
