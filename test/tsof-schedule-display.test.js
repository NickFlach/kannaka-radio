/**
 * tsof-schedule-display.test.js
 *
 * The Door prints a line-up; the scheduler decides what actually airs.
 * These two must never disagree, and the rotation must genuinely walk
 * the whole season rather than parking on one episode.
 *
 * Covers:
 *   1. pickTodayEpisode() walks every episode and never repeats two days
 *      running (the "different episode every day" promise).
 *   2. New-release priority pins the newest drop for 48h, then releases.
 *   3. The airing path reads the SAME picker the display reads.
 *   4. prettyEpisodeTitle() renders a filename as a title.
 *   5. /api/schedule's event list carries the 9 + 21 TSOF slots.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { PodcastScheduler, prettyEpisodeTitle } = require("../server/podcast-scheduler");

// Checks are queued, then awaited in order. A sync helper would have
// reported "ok" for the async check before its assertions ran — a green
// tick that proves nothing.
let failures = 0;
const queue = [];
function check(name, fn) {
  queue.push(async () => {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (e) {
      failures++;
      console.error(`  FAIL ${name}\n       ${e && e.message}`);
    }
  });
}

// ── Fixture: a season-one folder of eight episodes ─────────
const EPISODES = [
  "TSOF-E01-Shadows-in-the-Cornstone.mp3",
  "TSOF-E02-The-Algorithm-That-Bled.mp3",
  "TSOF-E03-The-Whisper-Cathedral.mp3",
  "TSOF-E04-Phantom-Code-Delta-33.mp3",
  "TSOF-E05-Yamibane.mp3",
  "TSOF-E06-Nullmen-Rising.mp3",
  "TSOF-E07-The-Black-Gate.mp3",
  "TSOF-E08-Obsidian-Echo.mp3",
];

const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsof-sched-"));
const showDir = path.join(musicDir, "The Story of Flaukowski");
fs.mkdirSync(showDir);
// Age every file well past the 48h new-release window so the rotation —
// not the new-release override — is what these tests observe.
const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
for (const f of EPISODES) {
  fs.writeFileSync(path.join(showDir, f), "x");
  fs.utimesSync(path.join(showDir, f), OLD, OLD);
}

function makeScheduler() {
  return new PodcastScheduler({
    djEngine: { state: { channel: "dj", playlist: [], playlistMeta: [], history: [] } },
    voiceDJ: {},
    broadcast: () => {},
    broadcastState: () => {},
    getMusicDir: () => musicDir,
    show: {
      label: "The Story of Flaukowski",
      folder: "The Story of Flaukowski",
      airHours: [9, 21],
      intro: (t) => t,
    },
  });
}

console.log("TSOF schedule display");

check("rotation walks the whole season and never repeats two days running", () => {
  const s = makeScheduler();
  const seen = new Set();
  let prev = null;
  // A full year of days — long enough to prove the cycle covers every
  // episode many times over, and to cross the year boundary once.
  for (let d = 0; d < 400; d++) {
    const day = new Date(2026, 0, 1 + d, 9, 0, 0);
    s._chicagoNow = () => day;
    const pick = s.pickTodayEpisode();
    assert.ok(pick, `no pick on day ${d}`);
    assert.ok(EPISODES.includes(pick.file), `unknown file ${pick.file}`);
    assert.notStrictEqual(
      pick.file, prev,
      `day ${d} (${day.toDateString()}) repeated ${pick.file} from the day before`);
    assert.strictEqual(pick.reason, "rotation");
    assert.strictEqual(pick.total, EPISODES.length);
    seen.add(pick.file);
    prev = pick.file;
  }
  assert.strictEqual(seen.size, EPISODES.length,
    `only ${seen.size}/${EPISODES.length} episodes ever aired`);
});

check("both airings on one day play the same episode (second-chance replay)", () => {
  const s = makeScheduler();
  s._chicagoNow = () => new Date(2026, 7, 23, 9, 0, 0);
  const morning = s.pickTodayEpisode();
  s._chicagoNow = () => new Date(2026, 7, 23, 21, 0, 0);
  const evening = s.pickTodayEpisode();
  assert.strictEqual(morning.file, evening.file);
});

check("a fresh drop preempts the rotation for 48h, then hands it back", () => {
  const s = makeScheduler();
  const fresh = path.join(showDir, "TSOF-E08-Obsidian-Echo.mp3");
  const now = new Date();
  fs.utimesSync(fresh, now, now);
  s._chicagoNow = () => new Date(2026, 7, 23, 9, 0, 0);
  let pick = s.pickTodayEpisode();
  assert.strictEqual(pick.file, "TSOF-E08-Obsidian-Echo.mp3");
  assert.strictEqual(pick.reason, "new-release");

  // Age it past the window — the rotation resumes.
  const stale = new Date(Date.now() - 49 * 60 * 60 * 1000);
  fs.utimesSync(fresh, stale, stale);
  pick = s.pickTodayEpisode();
  assert.strictEqual(pick.reason, "rotation");
});

check("an empty or missing show folder reports nothing rather than guessing", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tsof-empty-"));
  const s = makeScheduler();
  s._getMusicDir = () => empty;
  assert.strictEqual(s.pickTodayEpisode(), null);
  fs.rmSync(empty, { recursive: true, force: true });
});

check("the airing reads the same picker the display reads", async () => {
  const s = makeScheduler();
  s._chicagoNow = () => new Date(2026, 7, 23, 9, 0, 0);
  const displayed = s.pickTodayEpisode();

  // Drive _startScheduledPodcast far enough to see which file it loads.
  // The TTS failure path hands off after ~1s; wait past that.
  let loaded = null;
  s._playAllPodcastEpisodes = (files) => { loaded = files[0]; };
  s._voiceDJ = { generateTTS: (text, cb) => cb(new Error("no tts in test")) };
  await s._startScheduledPodcast();
  await new Promise((r) => setTimeout(r, 1300));
  assert.ok(loaded, "_startScheduledPodcast never reached playback");
  assert.strictEqual(loaded, displayed.file,
    `Door would print ${displayed.file} but the airing loaded ${loaded}`);
});

check("prettyEpisodeTitle turns a filename stem into a title", () => {
  assert.strictEqual(
    prettyEpisodeTitle("TSOF-E03-The-Whisper-Cathedral"),
    "E03 · The Whisper Cathedral");
  assert.strictEqual(
    prettyEpisodeTitle("TSOF-E05-Yamibane"), "E05 · Yamibane");
  // Not the show-prefix shape — still readable, not a filename.
  assert.strictEqual(prettyEpisodeTitle("Some_Other-Drop"), "Some Other Drop");
  assert.strictEqual(prettyEpisodeTitle(""), "");
  assert.strictEqual(prettyEpisodeTitle(null), "");
});

check("a 21:00 album showcase yields rather than cutting off the 21:00 drama", async () => {
  const { ProgrammingSchedule } = require("../server/programming");
  const { ALBUMS } = require("../server/dj-engine");
  const showcaseAlbum = "BEND THE ARC";
  assert.ok(ALBUMS[showcaseAlbum], "fixture assumes BEND THE ARC is a known album");

  const loaded = [];
  let podcastPlaying = false;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsof-prog-"));
  const p = new ProgrammingSchedule({
    djEngine: { state: { channel: "dj", currentAlbum: "REEF", currentTrackIdx: 0, playlist: [] },
                loadAlbum: (a) => { loaded.push(a); return { title: "t" }; } },
    voiceDJ: null,
    broadcast: () => {},
    broadcastState: () => {},
    getPodcastStatus: () => ({ podcastPlaying }),
    // The drama goes to air while the narration is still being composed —
    // exactly the 21:00 collision this guard exists for.
    peaceOration: {
      composeAlbumNarration: async () => {
        podcastPlaying = true;
        return { ok: true, pieces: [] };
      },
    },
    dataDir: stateDir,
    showcaseStateFile: path.join(stateDir, "showcase-state.json"),
  });
  p._chicagoNow = () => new Date(2026, 7, 23, 21, 0, 0);
  p._checkShowcaseTrigger();
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(!loaded.includes(showcaseAlbum),
    `showcase locked ${showcaseAlbum} on top of a live scheduled show`);
  assert.strictEqual(p._override, null,
    "showcase set an override while a scheduled show was on air");
  fs.rmSync(stateDir, { recursive: true, force: true });
});

check("/api/schedule declares TSOF at 9 and 21", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "server", "routes.js"), "utf8");
  const block = src.slice(src.indexOf('parsed.pathname === "/api/schedule"'));
  const events = block.slice(block.indexOf("const events = ["),
                            block.indexOf("];", block.indexOf("const events = [")));
  for (const h of [9, 21]) {
    assert.ok(new RegExp(`hour:\\s*${h}\\b`).test(events),
      `no daily event declared at hour ${h}`);
  }
  assert.ok(/The Story of Flaukowski/.test(events),
    "TSOF is not named in the schedule's event list");
  // And the hours it prints must be the hours the station actually airs.
  const idx = fs.readFileSync(
    path.join(__dirname, "..", "server", "index.js"), "utf8");
  const tsofBlock = idx.slice(idx.indexOf("const tsofScheduler = new PodcastScheduler("));
  const airHours = tsofBlock.slice(0, tsofBlock.indexOf("});"))
    .match(/airHours:\s*\[([^\]]+)\]/);
  assert.ok(airHours, "tsofScheduler declares no airHours");
  assert.deepStrictEqual(
    airHours[1].split(",").map((n) => parseInt(n.trim(), 10)), [9, 21],
    "the schedule display and the scheduler disagree about air hours");
});

(async () => {
  for (const run of queue) await run();
  fs.rmSync(musicDir, { recursive: true, force: true });
  if (failures) {
    console.error(`\n${failures} of ${queue.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`\nall ${queue.length} checks passed`);
})();
