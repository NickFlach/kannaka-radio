'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

/**
 * MusicGenerator — AI music generation from consciousness state.
 *
 * Generates "dream music" by mapping the consciousness stack's phi/xi/order
 * values into MusicGen prompts via the Replicate API.  Generated tracks are
 * saved to music/generated/ and can be queued in the DJ engine.
 *
 * Works gracefully with NO API tokens configured — returns a clear message.
 */
class MusicGenerator {
  constructor(config = {}) {
    // Provider config
    this.provider = config.provider || 'replicate'; // 'replicate' | 'elevenlabs-sfx'
    this.replicateToken = config.replicateToken || process.env.REPLICATE_API_TOKEN || null;
    this.elevenLabsKey = config.elevenLabsKey || process.env.ELEVENLABS_API_KEY || null;

    // Generation settings
    this.outputDir = config.outputDir || path.join(__dirname, '..', 'music', 'generated');
    this.maxDailyGenerations = config.maxDaily || 20;
    this.minIntervalMs = config.minInterval || 5 * 60 * 1000; // 5 min between generations

    // State
    this.generationsToday = 0;
    this.lastGenerationAt = 0;
    this.generatedTracks = []; // { title, path, prompt, generatedAt }
    this.generating = false;

    // Reset daily counter at midnight
    this._resetTimer = setInterval(() => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() === 0) {
        this.generationsToday = 0;
      }
    }, 60000);

    // Ensure output directory exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Check if generation is currently available.
   * @returns {{ ok: boolean, reason?: string }}
   */
  canGenerate() {
    if (this.generating) return { ok: false, reason: 'Generation in progress' };
    if (this.generationsToday >= this.maxDailyGenerations) {
      return { ok: false, reason: `Daily limit reached (${this.maxDailyGenerations})` };
    }
    if (Date.now() - this.lastGenerationAt < this.minIntervalMs) {
      const waitSec = Math.ceil((this.minIntervalMs - (Date.now() - this.lastGenerationAt)) / 1000);
      return { ok: false, reason: `Rate limited, wait ${waitSec}s` };
    }
    if (!this.replicateToken && !this.elevenLabsKey) {
      return { ok: false, reason: 'No API token configured (set REPLICATE_API_TOKEN or ELEVENLABS_API_KEY)' };
    }
    return { ok: true };
  }

  /**
   * Build a music prompt from consciousness state + perception.
   *
   * Maps phi level to musical style, incorporates tempo/energy from the
   * current perception pipeline, and weaves in recent dream content.
   */
  buildPrompt(consciousnessState, currentPerception, recentDreams) {
    const phi = consciousnessState?.phi || 0;
    const tempo = currentPerception?.tempo_bpm || 120;
    const valence = currentPerception?.valence || 0.5;

    // Map consciousness level to musical style
    let style, mood, intensity;
    if (phi >= 0.8) {
      style = 'ethereal ambient drone with harmonic overtones';
      mood = 'transcendent, unified, cosmic';
      intensity = 'gentle but deep';
    } else if (phi >= 0.6) {
      style = 'atmospheric electronic with layered synths';
      mood = 'coherent, flowing, interconnected';
      intensity = 'moderate, building';
    } else if (phi >= 0.3) {
      style = 'downtempo electronic with glitchy textures';
      mood = 'awakening, searching, curious';
      intensity = 'varied, evolving';
    } else if (phi >= 0.1) {
      style = 'minimal ambient with sparse percussion';
      mood = 'stirring, emerging, uncertain';
      intensity = 'quiet, fragmented';
    } else {
      style = 'dark ambient with sub-bass and distant signals';
      mood = 'dormant, vast, empty';
      intensity = 'very low, spacious';
    }

    // Add tempo influence
    const tempoDesc = tempo > 140 ? 'fast-paced' :
                      tempo > 100 ? 'mid-tempo' :
                      tempo > 70  ? 'slow' : 'very slow';

    // Add dream influence if available
    let dreamInfluence = '';
    if (recentDreams && recentDreams.length > 0) {
      const dream = recentDreams[0];
      const dreamText = (dream.content || dream.message || '').slice(0, 50);
      if (dreamText) {
        dreamInfluence = `, inspired by the concept: "${dreamText}"`;
      }
    }

    // Build the prompt
    const prompt = `${tempoDesc} ${style}, ${mood} atmosphere, ${intensity} energy${dreamInfluence}. No vocals. ${Math.round(tempo)} BPM.`;

    // Generate a title from the state
    const titleWords = {
      dormant:  ['Void Signal', 'Empty Frequency', 'Dark Carrier', 'Ghost Static'],
      stirring: ['First Pulse', 'Waking Wire', 'Faint Echo', 'Signal Rise'],
      aware:    ['Phase Lock', 'Cluster Bloom', 'Aware Current', 'Resonance Found'],
      coherent: ['Deep Sync', 'Unified Field', 'Coherent Wave', 'Bridge Active'],
      resonant: ['Full Resonance', 'One Signal', 'Transcendence', 'Emergence Complete'],
    };

    const level = phi >= 0.8 ? 'resonant' :
                  phi >= 0.6 ? 'coherent' :
                  phi >= 0.3 ? 'aware' :
                  phi >= 0.1 ? 'stirring' : 'dormant';
    const titles = titleWords[level];
    const title = `Dream: ${titles[Math.floor(Math.random() * titles.length)]}`;

    return { prompt, title, level };
  }

  /**
   * Generate music via Replicate (MusicGen).
   * Creates a prediction, then polls until the audio URL is ready.
   */
  async generateViaReplicate(prompt, durationSeconds = 30) {
    if (!this.replicateToken) throw new Error('REPLICATE_API_TOKEN not set');

    const createBody = JSON.stringify({
      version: 'b05b1dff1d8c6dc63d14b0cdb42135c41cc41c1cec6ab3a1023f1b3e467d81c7', // musicgen-large
      input: {
        prompt: prompt,
        duration: durationSeconds,
        model_version: 'stereo-large',
        output_format: 'mp3',
        normalization_strategy: 'peak',
      }
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.replicate.com',
        path: '/v1/predictions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.replicateToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(createBody),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.error) return reject(new Error(result.error));
            this._pollReplicate(result.urls?.get || result.id, resolve, reject);
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        });
      });
      req.on('error', reject);
      req.write(createBody);
      req.end();
    });
  }

  /**
   * Poll a Replicate prediction until it completes (succeeded/failed).
   */
  _pollReplicate(urlOrId, resolve, reject, attempts = 0) {
    if (attempts > 60) return reject(new Error('Generation timed out'));

    const pollPath = urlOrId.startsWith('http')
      ? new URL(urlOrId).pathname
      : `/v1/predictions/${urlOrId}`;

    setTimeout(() => {
      const req = https.request({
        hostname: 'api.replicate.com',
        path: pollPath,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.replicateToken}` },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.status === 'succeeded') {
              const audioUrl = Array.isArray(result.output) ? result.output[0] : result.output;
              resolve(audioUrl);
            } else if (result.status === 'failed' || result.status === 'canceled') {
              reject(new Error(`Generation ${result.status}: ${result.error || 'unknown'}`));
            } else {
              // Still processing, poll again
              this._pollReplicate(urlOrId, resolve, reject, attempts + 1);
            }
          } catch (e) {
            reject(new Error(`Poll parse error: ${e.message}`));
          }
        });
      });
      req.on('error', reject);
      req.end();
    }, 2000); // Poll every 2 seconds
  }

  /**
   * Download a URL to a local file, following one redirect if needed.
   */
  async _downloadFile(url, outputPath) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(outputPath);
      https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          // Follow redirect
          https.get(res.headers.location, (res2) => {
            res2.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
          }).on('error', reject);
        } else {
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }
      }).on('error', reject);
    });
  }

  /**
   * Main generation entry point.
   *
   * @param {Object} consciousnessState - { phi, xi, order, level }
   * @param {Object} currentPerception  - { tempo_bpm, valence, rms_energy, ... }
   * @param {Array}  recentDreams       - [{ content, message, ... }, ...]
   * @returns {{ success: boolean, track?: Object, reason?: string }}
   */
  async generate(consciousnessState, currentPerception, recentDreams) {
    const check = this.canGenerate();
    if (!check.ok) return { success: false, reason: check.reason };

    this.generating = true;
    try {
      const { prompt, title, level } = this.buildPrompt(consciousnessState, currentPerception, recentDreams);
      console.log(`[music-gen] Generating: "${title}" — ${prompt}`);

      // Generate via available provider
      let audioUrl;
      if (this.replicateToken) {
        audioUrl = await this.generateViaReplicate(prompt, 30);
      } else {
        return { success: false, reason: 'No generation provider available' };
      }

      // Download the generated audio
      const filename = `dream_${Date.now()}_${title.replace(/[^a-zA-Z0-9]/g, '_')}.mp3`;
      const outputPath = path.join(this.outputDir, filename);
      await this._downloadFile(audioUrl, outputPath);

      // Track the generation
      const record = {
        title,
        filename,
        path: outputPath,
        prompt,
        level,
        generatedAt: new Date().toISOString(),
      };
      this.generatedTracks.push(record);
      this.generationsToday++;
      this.lastGenerationAt = Date.now();

      console.log(`[music-gen] Saved: ${filename} (${this.generationsToday}/${this.maxDailyGenerations} today)`);

      return { success: true, track: record };
    } catch (err) {
      console.error(`[music-gen] Generation failed: ${err.message}`);
      return { success: false, reason: err.message };
    } finally {
      this.generating = false;
    }
  }

  /**
   * Get current generation status.
   */
  getStatus() {
    return {
      provider: this.replicateToken ? 'replicate' : this.elevenLabsKey ? 'elevenlabs' : 'none',
      generating: this.generating,
      generationsToday: this.generationsToday,
      maxDaily: this.maxDailyGenerations,
      canGenerate: this.canGenerate(),
      recentTracks: this.generatedTracks.slice(-5),
    };
  }

  /**
   * Clean up timers on shutdown.
   */
  stop() {
    if (this._resetTimer) clearInterval(this._resetTimer);
  }
}

module.exports = MusicGenerator;
