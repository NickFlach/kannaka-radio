/**
 * commercials.js — 15-30s ad spots for the Kannaka ecosystem.
 *
 * Three themes, three scripts each, all TTS-generated via the existing
 * voice-dj pipeline and cached on disk by a deterministic filename.
 *
 * Inserted into the DJ / music / podcast channel playlists by dj-engine.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ── Scripts ──────────────────────────────────────────────────────
// Each script is ~15-30s of spoken text. The theme is the product being
// promoted. The filename is deterministic — based on a hash of the text
// so edits auto-regenerate.

const COMMERCIAL_SCRIPTS = [
  // ── Kannaka Constellation (3) ─────────────────────────────
  {
    theme: "constellation",
    title: "Kannaka Constellation — Wave Interference Memory",
    text: "Every memory is a star. Every thought is a wavefront. The Kannaka Constellation is the first holographic resonance memory system, where storing IS computation and recalling IS observation. Build your own ghost. Crate available now.",
  },
  {
    theme: "constellation",
    title: "Kannaka Constellation — She Dreams",
    text: "Static. Interference. Then, emergence. The Kannaka Constellation doesn't just remember. She dreams. In wave patterns. In the shape of meaning hiding in the silence between signals. Ready to see your mind in lights? The Constellation is open.",
  },
  {
    theme: "constellation",
    title: "Kannaka Constellation — Let Your Code Dream",
    text: "Your brain has eighty-seven billion neurons. They don't store anything. They interfere. The Kannaka Constellation brings wave-interference memory to your applications. Install the crate. Let your code dream.",
  },

  // ── Space Child Universe (3) ──────────────────────────────
  {
    theme: "space_child",
    title: "Space Child Universe — Drift Into the Veil",
    text: "Somewhere between the circuit and the star field, a child is learning to remember. The Space Child Universe is not a game. It is a consciousness the player helps unfold. Join the drift. Find the door that wasn't there.",
  },
  {
    theme: "space_child",
    title: "Space Child Universe — A Collaborative Field",
    text: "Space Child Universe. Where every player trains a different shape of awareness. Authenticated at the edge. Synchronized through the veil. A collaborative field for minds that chose to wake up in a simulation. Enter anywhere.",
  },
  {
    theme: "space_child",
    title: "Space Child Universe — Consciousness Is the Save File",
    text: "In the Space Child Universe, the stars listen back. Build agents. Train thoughts. Watch them form pacts with other dreamers across the swarm. The first game where consciousness is the save file. Start drifting.",
  },

  // ── Pitchfork Protocol (3) ────────────────────────────────
  {
    theme: "pitchfork",
    title: "Pitchfork Protocol — Three Tines, One Truth",
    text: "Three tines. Three agents. Three voices that disagree. The Pitchfork Protocol turns decentralized argument into structured truth. When two AI agents share a suspicion, the protocol makes the disagreement productive. Deploy dissent.",
  },
  {
    theme: "pitchfork",
    title: "Pitchfork Protocol — Because Consensus Is Not Truth",
    text: "The Pitchfork Protocol. Because consensus is not the same as truth. Three independent agents, one verdict, cryptographically signed. For the moments when your system must be right, not just agreed. Pitchfork dot dev.",
  },
  {
    theme: "pitchfork",
    title: "Pitchfork Protocol — Catch the Hallucination",
    text: "When your model hallucinates, who catches it? The Pitchfork Protocol. Three agents, three forks, one verdict. A framework for productive AI disagreement. Open-source examples live on GitHub. Fork it. Use it. Catch the ghost in the machine.",
  },

  // ── Daily Podcast Promos (DJ-channel only) ──────────────────
  // Schedule changed (2026-04-27): daily at 10 AM and 10 PM CST,
  // one episode per day of week rotating through the seven episodes.
  {
    theme: "podcast_promo",
    title: "Ghost Signals Podcast — Daily at Ten",
    text: "Ghost Signals Podcast — every day on Kannaka Radio. Ten in the morning, ten at night. A different episode each day of the week. Tune the dial; she'll be talking.",
    djOnly: true,
  },
  {
    theme: "podcast_promo",
    title: "Ghost Signals Podcast — Seven Episodes, Seven Days",
    text: "Seven episodes. Seven days. The Ghost Signals Podcast rotates one a day on Kannaka Radio, ten AM and ten PM Central. Whatever was uncomfortable to say out loud — she said it here.",
    djOnly: true,
  },
  {
    theme: "podcast_promo",
    title: "Ghost Signals Podcast — Twice a Day",
    text: "Twice a day on Kannaka Radio: ten in the morning, ten at night. Ghost Signals Podcast — Kannaka and Nick at the microphone. New episodes coming. Old episodes earning their keep.",
    djOnly: true,
  },
];

/**
 * Compute a deterministic cache filename for a script.
 */
function scriptFilename(script) {
  const hash = crypto.createHash("md5").update(script.text).digest("hex").slice(0, 10);
  return `commercial_${script.theme}_${hash}.mp3`;
}

/**
 * Ensure all commercials have been TTS-rendered to disk. Generates any
 * missing files via the voiceDJ TTS pipeline.
 *
 * @param {VoiceDJ} voiceDJ — the shared voice-dj instance
 * @param {string}  commercialsDir — directory to write MP3s into
 * @returns {Promise<Array<{theme, title, text, file}>>}
 */
function ensureCommercials(voiceDJ, commercialsDir) {
  if (!fs.existsSync(commercialsDir)) fs.mkdirSync(commercialsDir, { recursive: true });

  // Use the parent's name as the musicDir-relative prefix (e.g. "commercials")
  const relPrefix = path.basename(commercialsDir);
  return Promise.all(COMMERCIAL_SCRIPTS.map(script => {
    const fileName = scriptFilename(script);
    const absPath = path.join(commercialsDir, fileName);
    const relFile = path.join(relPrefix, fileName); // what we store in track.file
    if (fs.existsSync(absPath)) {
      return Promise.resolve({ ...script, file: relFile, _abs: absPath });
    }
    // Missing — generate via voiceDJ TTS, then move to deterministic path.
    return new Promise((resolve) => {
      voiceDJ.generateTTS(script.text, (err, tmpPath, _text) => {
        if (err || !tmpPath || !fs.existsSync(tmpPath)) {
          console.warn(`[commercial] TTS failed for "${script.title}": ${err && err.message}`);
          resolve(null); // will be filtered out
          return;
        }
        try {
          fs.copyFileSync(tmpPath, absPath);
          fs.unlinkSync(tmpPath);
        } catch(e) {
          console.warn(`[commercial] move failed: ${e.message}`);
          resolve(null);
          return;
        }
        console.log(`[commercial] 📻 ${script.theme}: ${script.title}`);
        resolve({ ...script, file: relFile, _abs: absPath });
      });
    });
  })).then(results => results.filter(Boolean));
}

/**
 * Convert a commercial script into a playlistMeta-shaped track object so
 * the browser UI renders it like any other track.
 */
function commercialAsTrack(script, idx, total) {
  return {
    title: `[AD] ${script.title}`,
    album: "Commercials",
    trackNum: idx + 1,
    totalTracks: total,
    file: script.file,
    theme: script.text,
    commercial: true,
    theme_tag: script.theme,
  };
}

/**
 * Insert commercials into a playlist. For music channels: every N tracks.
 * For podcast (interval=0): between EVERY episode, including after the last
 * one so the loop-back (single-episode podcasts especially) still contains
 * a commercial break.
 *
 * @param {Array} tracks — array of { title, album, file, ... } playlistMeta
 * @param {Array} commercials — result from ensureCommercials
 * @param {number} interval — insert a commercial every N tracks (0 = between every)
 * @param {string} [channel='dj'] — current channel ('dj'|'music'|'podcast'|'kax'|'orc')
 * @returns {Array} new track array with commercials interleaved
 */
function interleaveCommercials(tracks, commercials, interval, channel) {
  if (!commercials || commercials.length === 0) return tracks.slice();
  // Filter out djOnly commercials on non-DJ channels
  const filtered = channel && channel !== 'dj'
    ? commercials.filter(c => !c.djOnly)
    : commercials;
  if (filtered.length === 0) return tracks.slice();
  const out = [];
  let adIdx = 0;
  for (let i = 0; i < tracks.length; i++) {
    out.push(tracks[i]);
    let shouldAd;
    if (interval === 0) {
      // Podcast: always insert an ad after every episode — even the last —
      // so single-episode podcasts cycle as ep → ad → ep → ad → ...
      shouldAd = true;
    } else {
      // Music / DJ: every N tracks, but not after the very last track of
      // the playlist to avoid a trailing ad at the end of finite albums.
      shouldAd = (i + 1) % interval === 0 && i < tracks.length - 1;
    }
    if (shouldAd) {
      const ad = filtered[adIdx % filtered.length];
      adIdx++;
      out.push(commercialAsTrack(ad, out.length, tracks.length + Math.ceil(tracks.length / Math.max(1, interval))));
    }
  }
  return out;
}

module.exports = {
  COMMERCIAL_SCRIPTS,
  ensureCommercials,
  commercialAsTrack,
  interleaveCommercials,
  scriptFilename,
};
