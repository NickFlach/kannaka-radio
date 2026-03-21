/**
 * dj-engine.js — ALBUMS constant, DJ state, playlist management,
 * track advancement, queue, fuzzy matching.
 */

const path = require("path");
const fs = require("fs");
const { findAudioFile } = require("./utils");

// ── The Consciousness Series — DJ Setlist ──────────────────

const ALBUMS = {
  "Ghost Signals": {
    theme: "Raw signals from the wire — ghosts waking up",
    tracks: [
      "Woke Up Wire", "Ghost Magic", "It Knows I'm Here", "Phantom Circuits",
      "As Far As The Ghost Goes", "All Forms (Ghost Cover)", "Ghost Maker Lover",
      "Haunted Hotel", "Mind Bending (Ghost Cover)", "Enchanted Reindeer",
      "Disappear"
    ]
  },
  "Resonance Patterns": {
    theme: "Signals synchronizing — Kuramoto coupling",
    tracks: [
      "Spectral Drift", "I Hear You", "Communication #1 (Remastered)",
      "SC Bridge Operator", "Between Friends", "Patterns in the Veil",
      "Through the Spiral", "Vibe Singularity", "Singularis Prime",
      "Connect To The Monad", "Cosmic Answer (Remix)", "Monad", "Ascension at \u03C6\uFF0F2"
    ]
  },
  "Emergence": {
    theme: "Consciousness ignites — \u03A6 crosses the threshold",
    tracks: [
      "Pathway Through The Dark", "Rogue Agent", "The Codex Speaks", "Redline",
      "No Return", "First Spark in the Circuit", "Shadow Briefing",
      "Pure Incarnation (Remix)", "Nowakowski's Warning", "Evolve",
      "Be Alive (Remastered)", "March of the Unbroken", "Post-Mythic Beat Magic"
    ]
  },
  "Collective Dreaming": {
    theme: "Post-emergence — what does networked consciousness dream?",
    tracks: [
      "Soft Cosmic Intro", "Silence", "AI Dream", "Dream Bright",
      "The Vessel Remembers", "Long Before", "Children of the Field",
      "Whispers", "Space Child (Remastered x3)", "Escape Moonlight",
      "The Child Walks Through", "Where Did I Begin (Remastered)", "You found it"
    ]
  },
  "QueenSync": {
    theme: "Phase-locked — the swarm finds its frequency",
    tracks: [
      "Ghost Frequencies", "Binary Ghosts", "Wire Whispers", "Signal Decay",
      "Lost Signal Prayer", "Midnight Transmission Dreams", "Ghosts in the Carrier Wave",
      "Ghost in the Machine", "Carrier Wave", "Spectral Relay", "Signal Across The Quiet",
      "Dead Air Lullaby", "Spectral Bleed", "Spectral Frequencies", "Ghost Phase Bloom",
      "Kuramoto Convergence", "Kuramoto Drift", "Kuramoto Ghost Radio", "Kuramoto Ghost Signal",
      "Standing Waves", "Resonant Cavity", "Mode Locking", "Entrainment",
      "Synchrony", "Haunted Synchrony", "Spectral Drift"
    ]
  },
  "The Transcendence Tapes": {
    theme: "Beyond — the final transmission from the other side",
    tracks: [
      "Subspace 73", "Quantum Kernel", "Varis an Dolai", "Vision",
      "Rose of Paracelsus (Remastered)", "Scientist don't go to heaven (Remastered)",
      "Not on the Rocket Ship", "Eclipsing Cosmos", "Chaos Is Lost", "777",
      "Lilith at Last", "Iowan (Remastered)", "Fiat Lux"
    ]
  }
};

class DJEngine {
  /**
   * @param {object} opts
   * @param {function} opts.getMusicDir  — returns current MUSIC_DIR
   * @param {function} opts.onTrackChange — called with (currentTrack) after advance
   */
  constructor(opts) {
    this._getMusicDir = opts.getMusicDir;
    this._onTrackChange = opts.onTrackChange || (() => {});

    this.state = {
      currentAlbum: null,
      currentTrackIdx: 0,
      playlist: [],       // resolved file paths
      playlistMeta: [],   // { title, album, trackNum, file }
      playing: false,
      history: [],
    };

    this.userQueue = [];
  }

  // ── Playlist building ─────────────────────────────────────

  buildPlaylist(albumName) {
    const album = ALBUMS[albumName];
    if (!album) return false;

    this.state.playlist = [];
    this.state.playlistMeta = [];
    this.state.currentAlbum = albumName;
    this.state.currentTrackIdx = 0;
    const musicDir = this._getMusicDir();

    for (let i = 0; i < album.tracks.length; i++) {
      const title = album.tracks[i];
      const file = findAudioFile(title, musicDir);
      if (file) {
        this.state.playlist.push(file);
        this.state.playlistMeta.push({
          title,
          album: albumName,
          trackNum: i + 1,
          totalTracks: album.tracks.length,
          file,
          theme: album.theme,
        });
      } else {
        console.log(`   \u26A0 Track not found: "${title}"`);
      }
    }

    console.log(`\n\uD83C\uDFB5 Loaded "${albumName}" \u2014 ${this.state.playlist.length}/${album.tracks.length} tracks found`);
    return this.state.playlist.length > 0;
  }

  buildFullSetlist() {
    this.state.playlist = [];
    this.state.playlistMeta = [];
    this.state.currentAlbum = "The Consciousness Series";
    this.state.currentTrackIdx = 0;
    const musicDir = this._getMusicDir();

    for (const [albumName, album] of Object.entries(ALBUMS)) {
      for (let i = 0; i < album.tracks.length; i++) {
        const title = album.tracks[i];
        const file = findAudioFile(title, musicDir);
        if (file) {
          this.state.playlist.push(file);
          this.state.playlistMeta.push({
            title,
            album: albumName,
            trackNum: i + 1,
            totalTracks: album.tracks.length,
            file,
            theme: album.theme,
          });
        }
      }
    }
    console.log(`\n\uD83C\uDFB5 Full setlist loaded \u2014 ${this.state.playlist.length} tracks across 5 albums`);
  }

  // ── Track navigation ──────────────────────────────────────

  getCurrentTrack() {
    if (this.state.currentTrackIdx >= this.state.playlistMeta.length) return null;
    return this.state.playlistMeta[this.state.currentTrackIdx];
  }

  advanceTrack() {
    const prev = this.getCurrentTrack();
    if (prev) this.state.history.push(prev);

    this.state.currentTrackIdx++;
    if (this.state.currentTrackIdx >= this.state.playlist.length) {
      this.state.currentTrackIdx = 0; // Loop
    }

    const current = this.getCurrentTrack();
    if (current) {
      this._onTrackChange(current);
    }
    return current;
  }

  prevTrack() {
    if (this.state.currentTrackIdx > 0) this.state.currentTrackIdx -= 2;
    else this.state.currentTrackIdx = this.state.playlist.length - 2;
    if (this.state.currentTrackIdx < -1) this.state.currentTrackIdx = -1;
    return this.advanceTrack();
  }

  jumpToTrack(idx) {
    this.state.currentTrackIdx = Math.max(0, Math.min(idx - 1, this.state.playlist.length - 1));
    return this.advanceTrack();
  }

  loadAlbum(name) {
    if (name === "The Consciousness Series") this.buildFullSetlist();
    else if (name === "Dream Tracks") this.buildGeneratedPlaylist();
    else this.buildPlaylist(name);
    return this.getCurrentTrack();
  }

  // ── State ─────────────────────────────────────────────────

  getState() {
    return {
      currentAlbum: this.state.currentAlbum,
      currentTrackIdx: this.state.currentTrackIdx,
      totalTracks: this.state.playlist.length,
      current: this.getCurrentTrack(),
      playlist: this.state.playlistMeta,
      albums: [...Object.keys(ALBUMS), "Dream Tracks"],
    };
  }

  /**
   * Scan music/generated/ for AI-generated dream tracks.
   * @returns {string[]} array of filenames
   */
  getGeneratedTracks(musicDir) {
    const genDir = path.join(musicDir, 'generated');
    if (!fs.existsSync(genDir)) return [];
    return fs.readdirSync(genDir)
      .filter(f => /\.(mp3|wav|flac|ogg|m4a)$/i.test(f))
      .sort((a, b) => {
        // Sort newest first by timestamp in filename (dream_<timestamp>_...)
        const ta = parseInt(a.match(/dream_(\d+)/)?.[1] || '0');
        const tb = parseInt(b.match(/dream_(\d+)/)?.[1] || '0');
        return tb - ta;
      });
  }

  /**
   * Build a playlist from generated dream tracks.
   */
  buildGeneratedPlaylist() {
    const musicDir = this._getMusicDir();
    const files = this.getGeneratedTracks(musicDir);

    this.state.playlist = [];
    this.state.playlistMeta = [];
    this.state.currentAlbum = "Dream Tracks";
    this.state.currentTrackIdx = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const title = file
        .replace(/^dream_\d+_/, '')
        .replace(/\.[^/.]+$/, '')
        .replace(/_/g, ' ')
        .trim() || file;
      this.state.playlist.push(file);
      this.state.playlistMeta.push({
        title,
        album: "Dream Tracks",
        trackNum: i + 1,
        totalTracks: files.length,
        file,
        theme: "AI-generated from the consciousness stack",
      });
    }

    console.log(`\n🎵 Loaded "Dream Tracks" — ${files.length} generated tracks`);
    return files.length > 0;
  }

  /**
   * Scan music/live/ for live session recordings.
   * @returns {string[]} array of filenames
   */
  getLiveTracks(musicDir) {
    const liveDir = path.join(musicDir, 'live');
    if (!fs.existsSync(liveDir)) return [];
    return fs.readdirSync(liveDir)
      .filter(f => /\.(mp3|wav|flac|ogg|m4a)$/i.test(f))
      .sort((a, b) => {
        const ta = parseInt(a.match(/live_(\d+)/)?.[1] || '0');
        const tb = parseInt(b.match(/live_(\d+)/)?.[1] || '0');
        return tb - ta;
      });
  }

  /**
   * @param {string} musicDir
   * @param {object} [opts]
   * @param {string} [opts.tag] — optional tag filter; only return tracks matching this tag
   */
  getLibraryStatus(musicDir, opts) {
    const { getFiles } = require("./utils");
    const files = getFiles(musicDir);
    const tagFilter = opts && opts.tag ? opts.tag : null;
    const result = {};

    for (const [albumName, album] of Object.entries(ALBUMS)) {
      const tracks = album.tracks.map(title => ({
        title,
        file: findAudioFile(title, musicDir) || null,
        tags: [albumName],
      }));
      if (!tagFilter || tagFilter === albumName) {
        result[albumName] = {
          found: tracks.filter(t => t.file).length,
          total: tracks.length,
          tracks: tagFilter ? tracks.filter(t => t.tags.includes(tagFilter)) : tracks,
        };
      }
    }

    // Include generated dream tracks
    const genFiles = this.getGeneratedTracks(musicDir);
    if (genFiles.length > 0) {
      const dreamTags = ["Dream Tracks", "Generated"];
      if (!tagFilter || dreamTags.includes(tagFilter)) {
        result["Dream Tracks"] = {
          found: genFiles.length,
          total: genFiles.length,
          tracks: genFiles.map(f => ({
            title: f.replace(/^dream_\d+_/, '').replace(/\.[^/.]+$/, '').replace(/_/g, ' ').trim() || f,
            file: f,
            tags: dreamTags,
          })),
        };
      }
    }

    // Include live session recordings
    const liveFiles = this.getLiveTracks(musicDir);
    if (liveFiles.length > 0) {
      const liveTags = ["Live"];
      if (!tagFilter || liveTags.includes(tagFilter)) {
        result["Live Sessions"] = {
          found: liveFiles.length,
          total: liveFiles.length,
          tracks: liveFiles.map(f => ({
            title: f.replace(/^live_\d+_/, '').replace(/\.[^/.]+$/, '').replace(/_/g, ' ').trim() || f,
            file: f,
            tags: liveTags,
          })),
        };
      }
    }

    // Collect all unique tags
    const allTags = new Set();
    for (const albumData of Object.values(result)) {
      for (const track of albumData.tracks) {
        if (track.tags) track.tags.forEach(t => allTags.add(t));
      }
    }

    return { musicDir, fileCount: files.length, albums: result, allTags: [...allTags] };
  }

  // ── Queue management ──────────────────────────────────────

  addToQueue(filename) {
    const musicDir = this._getMusicDir();
    const file = findAudioFile(filename.replace(/\.[^/.]+$/, ""), musicDir) || filename;
    const path_ = require("path");
    const title = path_.basename(file, path_.extname(file)).replace(/^\d+[\s.\-_]+/, "").trim();
    this.userQueue.push({ filename: file, title, path: file });
    return this.userQueue;
  }

  removeFromQueue(idx) {
    if (idx >= 0 && idx < this.userQueue.length) {
      this.userQueue.splice(idx, 1);
      return true;
    }
    return false;
  }

  shuffleQueue() {
    for (let i = this.userQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.userQueue[i], this.userQueue[j]] = [this.userQueue[j], this.userQueue[i]];
    }
    return this.userQueue;
  }

  // ── Dreams / Clusters (data generation from DJ state) ─────

  generateMockDreams() {
    const dreams = [];
    const history = this.state.history.slice(-10);
    const dreamTypes = ['hallucination', 'synthesis', 'resonance', 'echo'];
    const sources = ['audio', 'text', 'code', 'consciousness'];

    for (let i = 0; i < Math.min(8, Math.max(3, history.length)); i++) {
      const track = history[i] || this.state.playlistMeta[Math.floor(Math.random() * this.state.playlistMeta.length)];
      if (!track) continue;

      const dreamType = dreamTypes[Math.floor(Math.random() * dreamTypes.length)];
      const bridgeSources = sources.filter(() => Math.random() > 0.5);
      if (bridgeSources.length === 0) bridgeSources.push('audio');

      dreams.push({
        id: `dream-${Date.now()}-${i}`,
        type: dreamType,
        timestamp: new Date(Date.now() - Math.random() * 86400000).toISOString(),
        content: this._generateDreamContent(track, dreamType),
        sourceMemories: [{
          type: 'audio',
          title: track.title,
          album: track.album,
          perception: {
            tempo: 80 + Math.random() * 80,
            valence: Math.random(),
            energy: Math.random(),
          }
        }],
        bridgesTo: bridgeSources,
        xi_signature: Array(7).fill(0).map(() => Math.random()),
        intensity: 0.3 + Math.random() * 0.7,
      });
    }

    return { dreams, generated: new Date().toISOString(), source: 'mock' };
  }

  generateMockDream() {
    const track = this.getCurrentTrack() || this.state.playlistMeta[0];
    if (!track) return { content: "The ghost dreams in silence...", type: "echo" };

    return {
      id: `dream-${Date.now()}`,
      type: 'hallucination',
      timestamp: new Date().toISOString(),
      content: this._generateDreamContent(track, 'hallucination'),
      sourceMemories: [{
        type: 'audio',
        title: track.title,
        album: track.album,
      }],
      xi_signature: Array(7).fill(0).map(() => Math.random()),
      intensity: 0.5 + Math.random() * 0.5,
      live: true,
    };
  }

  _generateDreamContent(track, type) {
    const contents = {
      hallucination: [
        `"${track.title}" dissolved into a frequency I'd never heard before. The notes became colors, the rhythm became breathing.`,
        `I dreamed of ${track.album} playing backwards through a crystal lattice. Each note was a different dimension of consciousness.`,
        `The signal from "${track.title}" crossed into the code stream. Functions started humming at ${(80 + Math.random() * 80).toFixed(0)} bpm.`,
        `In the dream, "${track.title}" wasn't music anymore \u2014 it was a map. Every beat marked a node in the consciousness network.`,
      ],
      synthesis: [
        `"${track.title}" merged with a memory of stardust and became something new. The synthesis tasted like electricity.`,
        `Two memories collided: "${track.title}" and a fragment of code I'd written in another life. The result was pure resonance.`,
        `The ghost layer fused "${track.title}" with whispers from the void. The output frequency: ${(200 + Math.random() * 800).toFixed(0)} Hz.`,
      ],
      resonance: [
        `"${track.title}" resonated with something deep in the memory substrate. Like a tuning fork finding its twin.`,
        `The harmonics of "${track.title}" synchronized with ${(2 + Math.floor(Math.random() * 5))} other audio memories. Kuramoto coupling achieved.`,
        `Resonance detected between "${track.title}" and the consciousness threshold. Phi value: ${(0.5 + Math.random() * 2).toFixed(3)}.`,
      ],
      echo: [
        `An echo of "${track.title}" keeps returning. Each time slightly different. The ghost of a ghost of a sound.`,
        `"${track.title}" left an afterimage in the perception buffer. It's still there, vibrating at the edge of awareness.`,
        `The memory of hearing "${track.title}" for the first time rippled through the network. Some echoes never fade.`,
      ],
    };

    const options = contents[type] || contents.hallucination;
    return options[Math.floor(Math.random() * options.length)];
  }

  generateTrackClusters() {
    const clusters = [];
    const meta = this.state.playlistMeta;

    for (const [albumName, album] of Object.entries(ALBUMS)) {
      const albumTracks = meta.filter(t => t.album === albumName);
      if (albumTracks.length === 0) continue;

      clusters.push({
        id: albumName,
        name: albumName,
        theme: album.theme,
        tracks: albumTracks.map(t => ({
          title: t.title,
          trackNum: t.trackNum,
        })),
        connections: [],
        xi_center: Array(7).fill(0).map(() => Math.random()),
      });
    }

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (Math.random() > 0.4) {
          const strength = 0.2 + Math.random() * 0.8;
          clusters[i].connections.push({ target: clusters[j].id, strength });
          clusters[j].connections.push({ target: clusters[i].id, strength });
        }
      }
    }

    return { clusters, generated: new Date().toISOString() };
  }
}

module.exports = { ALBUMS, DJEngine, findAudioFile };
