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
//
// The drain alone does not save the recorded 217s case, because the ceiling is
// bounded by systemd's TimeoutStopSec, not by this code. The other half is
// that a cut oration must not be RECORDED as delivered: `_lastFired[key]` is
// persisted when the audio is queued, so the relaunch skipped the slot and the
// oration was lost for good. Releasing the slot lets the same window re-fire
// it — the second group of tests below.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IcecastSource } = require('../server/icecast-source');
const { PeaceOration } = require('../server/peace-oration');
const { saveState, loadState } = require('../server/lib/scheduler-helpers');

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

/** A noon slot key in the shape _keyFor produces. Dynamic so it stays within
 *  loadState's 3-day rolling window regardless of when the suite runs. */
const SLOT_KEY = new Date().toISOString().slice(0, 10) + 'T12';

/**
 * A PeaceOration with a fake voiceDJ and a real temp state file — the bug is
 * about what the RELAUNCH reads back off disk, so the persistence is exercised
 * rather than stubbed.
 */
function makeOration() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oration-slot-'));
  let onDone = null;
  const oration = new PeaceOration({
    kannakabin: 'kannaka',
    voiceDJ: { executeOration(text, cb) { onDone = cb; return true; } },
    broadcast() {},
    dataDir: dir,
  });
  return {
    oration,
    dir,
    /**
     * What _tick does once _say accepts the oration: mark the slot and persist
     * it, so the 30s ticker cannot queue the same oration again while it plays.
     */
    fire(key = SLOT_KEY) {
      assert.ok(oration._say('an oration body', key),
        'setup: the fake voiceDJ should accept the oration');
      oration._lastFired[key] = true;
      saveState(oration._stateFile, oration._lastFired);
      return key;
    },
    /** Drive the delivery callback voice-dj invokes when the audio ends. */
    finish(err) { onDone(err || null); },
  };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
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

  // ── The slot must not record a delivery the listener never heard ──────

  await run('#54 a delivery that never aired hands its slot back', async () => {
    const { oration, dir, fire, finish } = makeOration();
    try {
      const key = fire();
      assert.strictEqual(loadState(oration._stateFile)[key], true,
        'setup: the slot is marked the moment the audio is queued');

      finish(new Error('TTS failed after retries'));

      assert.strictEqual(oration._lastFired[key], undefined,
        'a slot whose audio never aired must not stay marked delivered');
      assert.strictEqual(loadState(oration._stateFile)[key], undefined,
        'the release must be PERSISTED — the relaunch reads the file, not memory');
    } finally { cleanup(dir); }
  });

  await run('#54 a shutdown that cut the oration hands its slot back', async () => {
    // What server/index.js does when stop({drain:true}) reports it did not
    // finish: the listener heard part of an oration, so the slot is owed.
    const { oration, dir, fire } = makeOration();
    try {
      const key = fire();
      const released = oration.releaseInFlightSlot('shutdown:ceiling');

      assert.strictEqual(released, key, 'the cut slot should be reported back');
      assert.strictEqual(loadState(oration._stateFile)[key], undefined,
        'the relaunch must see the slot as unfired so its window can retry');
    } finally { cleanup(dir); }
  });

  await run('#54 an oration that aired cleanly keeps its slot', async () => {
    // The other direction, and the one that matters most: a completed
    // oration must never re-fire, or a restart minutes later would air it
    // a second time.
    const { oration, dir, fire, finish } = makeOration();
    try {
      const key = fire();
      finish(null); // delivered

      assert.strictEqual(oration.releaseInFlightSlot('shutdown:ceiling'), null,
        'nothing is in flight once the oration completed');
      assert.strictEqual(loadState(oration._stateFile)[key], true,
        'a delivered oration must stay marked so it cannot air twice');
    } finally { cleanup(dir); }
  });

  await run('#54 releasing with nothing in flight is a no-op', async () => {
    // Shutdown calls this on every non-clean drain, including ones where a
    // music track was playing and no oration was ever queued.
    const { oration, dir } = makeOration();
    try {
      assert.strictEqual(oration.releaseInFlightSlot('shutdown:no-voice-in-flight'), null);
      assert.deepStrictEqual(oration._lastFired, {}, 'must not disturb other slots');
    } finally { cleanup(dir); }
  });

  await run('#54 a manual deliverNow failure releases nothing', async () => {
    // deliverNow and showcaseAlbum own no scheduled slot. A failure there
    // must not hand back a slot that a scheduled oration is holding.
    const { oration, dir, fire } = makeOration();
    try {
      const key = fire();                 // the scheduled oration is in flight
      let manualDone = null;
      oration._voiceDJ.executeOration = (t, onDone) => { manualDone = onDone; return true; };
      oration._say('a manual oration');   // no slot key
      manualDone(new Error('TTS failed'));

      assert.strictEqual(loadState(oration._stateFile)[key], true,
        'the scheduled slot must survive an unrelated manual failure');
    } finally { cleanup(dir); }
  });

  await run('#54 the scheduler still tells _say which slot it is delivering', async () => {
    // The wiring that makes all of the above reachable: if _tick goes back to
    // calling _say(text) with no key, nothing is ever in flight and every
    // release silently becomes a no-op.
    const SRC = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'peace-oration.js'), 'utf8');
    assert.ok(/const ok = this\._say\(text, key\);/.test(SRC),
      '_tick must pass the slot key to _say, or the slot can never be released');
    const IDX = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    assert.ok(/releaseInFlightSlot\(`shutdown:/.test(IDX),
      'shutdown() must release the slot when the drain did not complete');
  });

  console.log(failed === 0 ? '\nshutdown-voice-drain: all passed' : `\nshutdown-voice-drain: ${failed} FAILED`);
  if (failed > 0) process.exit(1);
})();
