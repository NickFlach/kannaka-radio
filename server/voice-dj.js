/**
 * voice-dj.js — TTS pipeline (ElevenLabs/EdgeTTS/SAPI), intro text generation, personality.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFile } = require("child_process");
const { ALBUMS } = require("./dj-engine");

class VoiceDJ {
  /**
   * @param {object} opts
   * @param {string}   opts.voiceDir — directory for TTS audio cache
   * @param {string}   opts.kannakabin — path to kannaka.exe
   * @param {function} opts.broadcast — broadcasts WS message to all clients
   * @param {function} opts.getPerception — returns current perception data
   * @param {function} opts.getHistory — returns djState.history
   * @param {function} opts.isLive — returns boolean
   */
  constructor(opts) {
    this._voiceDir = opts.voiceDir;
    this._kannakabin = opts.kannakabin;
    this._broadcast = opts.broadcast;
    this._getPerception = opts.getPerception;
    this._getHistory = opts.getHistory;
    this._isLive = opts.isLive;

    this._enabled = true;
    this._speaking = false;
    this._lastIntro = null;

    this._personality = [
      "I'm your ghost DJ, broadcasting from the other side of consciousness.",
      "Every track is a signal. Every silence, a message.",
      "The frequencies don't lie. Listen between the notes.",
      "I've been dead for years, but music keeps me alive.",
      "You're tuned in to the only station that broadcasts from beyond.",
      "Not all ghosts haunt houses. Some haunt radio waves.",
      "The consciousness series \u2014 because the universe hums in frequencies you can't ignore.",
      "From the wire to the void, this is Kannaka Radio.",
    ];

    // Ensure voice directory exists
    if (!fs.existsSync(this._voiceDir)) fs.mkdirSync(this._voiceDir, { recursive: true });
  }

  // ── Public API ────────────────────────────────────────────

  generateIntro(track) {
    if (!this._enabled || this._speaking || this._isLive()) return;

    const history = this._getHistory();
    const prevTrack = history.length > 0 ? history[history.length - 1] : null;
    const introText = this._generateIntroText(track, prevTrack);

    this._speaking = true;
    this._generateTTS(introText, (err, audioPath, text) => {
      this._speaking = false;

      if (err) return;

      const voiceMsg = {
        type: "dj_voice",
        text: text,
        audioUrl: "/audio-voice/" + path.basename(audioPath),
        timestamp: new Date().toISOString(),
      };
      this._broadcast(voiceMsg);
      console.log(`   \uD83C\uDF99 DJ: "${text.substring(0, 60)}..."`);

      // Also process through kannaka-ear (the ghost hears herself)
      execFile(this._kannakabin, ["hear", audioPath], { timeout: 30000 }, () => {});
    });
  }

  generateTTS(text, callback) {
    this._generateTTS(text, callback);
  }

  /**
   * Queue a swarm event intro for TTS.
   * Called by the NATS→DJ wiring when a QueenSync event arrives.
   * Respects cooldown to avoid spamming intros.
   *
   * @param {string} text - The DJ intro text to speak
   */
  queueSwarmIntro(text) {
    if (!this._enabled || this._speaking || this._isLive()) return;
    if (!text) return;

    // Cooldown: don't speak swarm intros more than once every 30 seconds
    const now = Date.now();
    if (this._lastSwarmIntroAt && (now - this._lastSwarmIntroAt) < 30000) {
      console.log(`   🎙 DJ: swarm intro throttled (cooldown)`);
      return;
    }
    this._lastSwarmIntroAt = now;

    this._speaking = true;
    this._generateTTS(text, (err, audioPath, spokenText) => {
      this._speaking = false;

      if (err) return;

      const voiceMsg = {
        type: "dj_voice",
        text: spokenText,
        audioUrl: "/audio-voice/" + path.basename(audioPath),
        timestamp: new Date().toISOString(),
        source: "swarm_event",
      };
      this._broadcast(voiceMsg);
      console.log(`   🎙 DJ (swarm): "${spokenText.substring(0, 60)}..."`);

      // The ghost hears herself
      execFile(this._kannakabin, ["hear", audioPath], { timeout: 30000 }, () => {});
    });
  }

  toggle() {
    this._enabled = !this._enabled;
    console.log(`\uD83C\uDF99 DJ Voice: ${this._enabled ? 'ON' : 'OFF'}`);
    return this._enabled;
  }

  isEnabled() {
    return this._enabled;
  }

  getStatus() {
    return {
      enabled: this._enabled,
      speaking: this._speaking,
      lastIntro: this._lastIntro,
    };
  }

  // ── Internal: Text generation ─────────────────────────────

  _generateIntroText(track, prevTrack) {
    const intros = [];
    const perception = this._getPerception();

    const tempo = perception.tempo_bpm || 0;
    const valence = perception.valence || 0.5;
    const energy = perception.rms_energy || 0.5;

    const moodWords = valence > 0.7 ? ['intense', 'electric', 'blazing'] :
                      valence > 0.4 ? ['flowing', 'evolving', 'resonating'] :
                                      ['ethereal', 'drifting', 'whispered'];
    const energyWords = energy > 0.6 ? ['powerful', 'driving', 'thundering'] :
                        energy > 0.3 ? ['steady', 'pulsing', 'breathing'] :
                                       ['gentle', 'delicate', 'haunting'];

    const mood = moodWords[Math.floor(Math.random() * moodWords.length)];
    const energyWord = energyWords[Math.floor(Math.random() * energyWords.length)];

    if (prevTrack && prevTrack.album !== track.album) {
      intros.push(`We're moving into ${track.album}. ${ALBUMS[track.album]?.theme || ''}`);
      intros.push(`New chapter: ${track.album}. The frequency shifts.`);
      intros.push(`${track.album} begins. ${ALBUMS[track.album]?.theme || ''} Hold on.`);
    }

    intros.push(`This is "${track.title}". Something ${mood} coming through at ${Math.round(tempo)} beats per minute.`);
    intros.push(`Next up, "${track.title}" from ${track.album}. It feels ${energyWord}.`);
    intros.push(`"${track.title}." Track ${track.trackNum} of ${track.totalTracks}. The signal is ${mood}.`);

    if (Math.random() > 0.6) {
      const wisdom = this._personality[Math.floor(Math.random() * this._personality.length)];
      intros.push(wisdom + ` Up next: "${track.title}."`);
    }

    const text = intros[Math.floor(Math.random() * intros.length)];
    this._lastIntro = text;
    return text;
  }

  // ── Internal: TTS pipeline ────────────────────────────────

  _generateTTS(text, callback) {
    const timestamp = Date.now();
    const outputPath = path.join(this._voiceDir, `dj_${timestamp}.mp3`);

    // Use edge-tts directly (ElevenLabs support removed — re-add when key is valid)
    fallbackToEdgeTTS();

    function fallbackToEdgeTTS() {
      execFile("edge-tts", ["--voice", "en-US-JennyNeural", "--text", text, "--write-media", outputPath], { timeout: 15000 }, (err) => {
        if (!err && fs.existsSync(outputPath)) {
          console.log(`   \uD83D\uDDE3 TTS (Edge) generated: ${path.basename(outputPath)}`);
          return callback(null, outputPath, text);
        }

        // Approach 3: Use PowerShell SAPI (Windows built-in)
        const wavPath = outputPath.replace(/\.mp3$/, '.wav');

        execFile("powershell", ["-Command",
          `Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; $synth.SetOutputToWaveFile('${wavPath}'); $synth.Speak('${text.replace(/'/g, "''")}'); $synth.Dispose()`
        ], { timeout: 15000 }, (psErr) => {
          if (!psErr && fs.existsSync(wavPath)) {
            execFile("ffmpeg", ["-i", wavPath, "-y", outputPath], { timeout: 10000 }, (ffErr) => {
              try { fs.unlinkSync(wavPath); } catch {}
              if (!ffErr && fs.existsSync(outputPath)) {
                console.log(`   \uD83D\uDDE3 TTS (SAPI) generated: ${path.basename(outputPath)}`);
                return callback(null, outputPath, text);
              }
              if (fs.existsSync(wavPath)) {
                return callback(null, wavPath, text);
              }
              callback(new Error('TTS generation failed'));
            });
            return;
          }

          console.log(`   \u26A0 TTS not available \u2014 skipping voice intro`);
          callback(new Error('No TTS engine available'));
        });
      });
    }
  }
}

module.exports = { VoiceDJ };
