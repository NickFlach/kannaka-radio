'use strict';

// shutdown-voice-drain.test.js — a restart must not cut an oration
// mid-sentence (#54).
//
// `icecastSource.stop()` SIGTERM'd ffmpeg immediately, and `shutdown()` in
// server/index.js never called it at all — ffmpeg simply died with the process.
// A restart 80s into a 217s peace oration gave listeners ~80s of speech, ~12s
// of silence, then the next track. The oration is a one-shot performance; it
// cannot be rejoined on the next boot the way a music track can.
//
// `stop({ drain: true })` now waits for an in-flight VOICE file to finish,
// under a ceiling.

const assert = require('assert');
const { IcecastSource } = require('../server/icecast-source');

let failed = 0;
function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((e) => { console.log(`  ✗ ${name}: ${e.message}`); failed++; });
}

/** A source with no real ffmpeg/network, just the state stop() reads. */
function makeSource() {
  const src = Object.create(IcecastSource.prototype);
  src._running = true;
  src._restartTimer = null;
  src._voiceQueue = [];
  src._currentVoice = null;
  src._draining = false;
  src._killed = 0;
  src._ffmpeg = {
    stdin: { end() {} },
    kill() { src._killed += 1; },
  };
  return src;
}

(async () => {
  await run('#54 stop() waits for an in-flight voice file instead of killing it', async () => {
    const src = makeSource();
    src._currentVoice = { path: '/tmp/oration.mp3', meta: { label: 'noon peace oration' } };

    const stopping = src.stop({ drain: true, maxDrainMs: 5000 });

    // Still mid-oration: ffmpeg must NOT have been killed yet.
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(src._killed, 0, 'ffmpeg was killed while voice was still streaming');

    // The voice finishes, as the real _loop() finally-block does.
    src._currentVoice = null;
    const result = await stopping;

    assert.strictEqual(result.drained, true, `expected a clean drain, got ${JSON.stringify(result)}`);
    assert.strictEqual(result.reason, 'completed');
    assert.strictEqual(src._killed, 1, 'ffmpeg should be stopped once the voice drained');
  });

  await run('#54 the ceiling still cuts a voice that never ends', async () => {
    // The other direction: a stuck file must not hold shutdown open forever.
    // systemd would SIGKILL us anyway, so the ceiling has to be ours.
    const src = makeSource();
    src._currentVoice = { path: '/tmp/stuck.mp3', meta: { label: 'stuck' } };

    const result = await src.stop({ drain: true, maxDrainMs: 600 });

    assert.strictEqual(result.drained, false);
    assert.strictEqual(result.reason, 'ceiling');
    assert.strictEqual(src._killed, 1, 'ffmpeg must be killed once the ceiling passes');
  });

  await run('#54 music is never drained — only voice', async () => {
    // Draining a 5-minute music track on every deploy would make restarts
    // worse. Music is resumable; the next boot just picks a track.
    const src = makeSource();
    src._currentVoice = null; // a music track is streaming

    const result = await src.stop({ drain: true });

    assert.strictEqual(result.drained, false);
    assert.strictEqual(result.reason, 'no-voice-in-flight');
    assert.strictEqual(src._killed, 1, 'music should stop immediately');
  });

  await run('#54 stop() without drain keeps the old immediate behaviour', async () => {
    const src = makeSource();
    src._currentVoice = { path: '/tmp/oration.mp3', meta: { label: 'oration' } };

    const result = await src.stop();

    assert.strictEqual(result.drained, false);
    assert.strictEqual(src._killed, 1, 'a plain stop() must not wait');
    assert.strictEqual(src._running, false);
  });

  await run('#54 stop() always clears _running so the voice loop takes no new items', async () => {
    const src = makeSource();
    src._currentVoice = { path: '/tmp/a.mp3', meta: {} };
    const stopping = src.stop({ drain: true, maxDrainMs: 400 });
    // Must be false IMMEDIATELY, not after the drain — otherwise the loop
    // would pull the next queued oration while we are trying to shut down.
    assert.strictEqual(src._running, false, '_running must clear before the drain completes');
    await stopping;
  });

  await run('#54 the drain ceiling stays under systemd default TimeoutStopSec', async () => {
    // A ceiling above 90s is SIGKILLed mid-drain and produces the exact cut
    // this fix prevents, while looking configured. Pinned so a future bump
    // has to confront the coupling.
    const src = makeSource();
    src._currentVoice = null;
    const SRC = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'server', 'icecast-source.js'), 'utf8');
    const m = SRC.match(/Number\.isFinite\(raw\) && raw >= 0 \? raw : (\d+)/);
    assert.ok(m, 'could not find the default drain ceiling');
    const ms = Number(m[1]);
    assert.ok(ms > 0, 'a zero default would disable the drain');
    assert.ok(ms < 90000, `default ceiling ${ms}ms must stay under systemd's 90s default`);
  });

  console.log(failed === 0 ? '\nshutdown-voice-drain: all passed' : `\nshutdown-voice-drain: ${failed} FAILED`);
  if (failed > 0) process.exit(1);
})();
