'use strict';

/**
 * audio-reachability.test.js — audio that is present and cannot be played.
 *
 * `server/audio-reachability.js` shipped without a test. Its own header records
 * why that is uncomfortable: the first version of this audit reported 127 files
 * across 19 album folders as unreachable, and was wrong, because it checked
 * which folder NAMES appeared in the source instead of asking the resolver what
 * it could actually find. Those albums were reachable the whole time.
 *
 * The module was reshaped around that mistake — it now asks the real resolver
 * and reports two conditions separately — but nothing pinned the distinction,
 * so nothing would notice it collapsing again. That is what these tests are for.
 *
 *   UNREACHED         present and resolvable, but no curated album names it.
 *   INVISIBLE FOLDER  a directory the resolver never lists at all. This is the
 *                     condition that silenced all eight episodes of The Story
 *                     of Flaukowski for four days in August 2026.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  auditReachability,
  unreachedFiles,
  invisibleFolders,
  byFolder,
  AUDIO_RE,
} = require('../server/audio-reachability');

let failed = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}

console.log('audio-reachability.test.js');

// --- unreachedFiles ---------------------------------------------------------

t('a loose file no album names is unreached', () => {
  const all = ['drifting.mp3', 'Albums/one.mp3'];
  assert.deepStrictEqual(unreachedFiles(all, ['Albums/one.mp3']), ['drifting.mp3']);
});

t('a file a curated album names is NOT unreached', () => {
  const all = ['Albums/one.mp3'];
  assert.deepStrictEqual(unreachedFiles(all, ['Albums/one.mp3']), []);
});

t('a file owned by another channel is NOT unreached', () => {
  // The podcast and TSOF folders are aired by their own channels, so the DJ
  // never naming them is correct rather than a finding.
  const all = [
    path.join('Ghost Signals Podcast', 'gsp-034.mp3'),
    path.join('The Story of Flaukowski', 'e01.mp3'),
    path.join('radio-ads', 'sponsor.mp3'),
  ];
  assert.deepStrictEqual(unreachedFiles(all, []), []);
});

t('ownership is exact, not a prefix match', () => {
  // "generated-old" is not "generated". Treating it as owned would hide a real
  // folder full of audio nothing plays.
  const all = [path.join('generated-old', 'x.mp3')];
  assert.deepStrictEqual(unreachedFiles(all, []), [path.join('generated-old', 'x.mp3')]);
});

t('an empty library yields no findings rather than throwing', () => {
  assert.deepStrictEqual(unreachedFiles([], []), []);
});

// --- byFolder ---------------------------------------------------------------

t('byFolder groups, labels root files, and sorts by count descending', () => {
  const got = byFolder([
    path.join('B', '1.mp3'),
    'loose1.mp3',
    'loose2.mp3',
    'loose3.mp3',
    path.join('B', '2.mp3'),
  ]);
  assert.deepStrictEqual(got, [
    { folder: '(root level)', files: 3 },
    { folder: 'B', files: 2 },
  ]);
});

// --- invisibleFolders (filesystem) ------------------------------------------

function tmpLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-'));
  const mk = (name, files) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dir, name, f), 'x');
  };
  mk('Seen Album', ['a.mp3']);          // resolver lists it
  mk('Hidden Album', ['b.mp3', 'c.mp3']); // resolver does NOT — the TSOF case
  mk('The Story of Flaukowski', ['e01.mp3']); // channel-owned, not a finding
  mk('Sleeve Notes', ['notes.txt']);    // no playable audio, not a finding
  fs.mkdirSync(path.join(dir, 'Empty'), { recursive: true });
  return dir;
}

t('THE REGRESSION: a folder the resolver never lists is a finding', () => {
  const dir = tmpLibrary();
  const resolverSees = [path.join('Seen Album', 'a.mp3')];
  const got = invisibleFolders(dir, resolverSees);
  assert.deepStrictEqual(got, [{ folder: 'Hidden Album', files: 2 }]);
});

t('a folder the resolver DOES list is not invisible, even if no album names it', () => {
  // This is the mistake the module's header describes. A reachable-but-unnamed
  // album belongs in `unreached`; calling it invisible is how 127 files got
  // reported as a crisis they were not.
  const dir = tmpLibrary();
  const resolverSees = [
    path.join('Seen Album', 'a.mp3'),
    path.join('Hidden Album', 'b.mp3'),
  ];
  assert.deepStrictEqual(invisibleFolders(dir, resolverSees), []);
  // ...and it IS reported by the other half, so the audio is not lost from the
  // report — only from the wrong column.
  assert.ok(unreachedFiles(resolverSees, []).length > 0);
});

t('channel-owned folders are not findings', () => {
  const dir = tmpLibrary();
  const got = invisibleFolders(dir, []);
  assert.ok(!got.some((f) => f.folder === 'The Story of Flaukowski'));
});

t('a folder with no playable audio is not a finding', () => {
  const dir = tmpLibrary();
  const got = invisibleFolders(dir, []);
  assert.ok(!got.some((f) => f.folder === 'Sleeve Notes'), 'a .txt is not silence');
  assert.ok(!got.some((f) => f.folder === 'Empty'), 'an empty folder has no silence to explain');
});

t('findings are sorted, so the report is stable between boots', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-sort-'));
  for (const n of ['Zed', 'Alpha', 'Mid']) {
    fs.mkdirSync(path.join(dir, n), { recursive: true });
    fs.writeFileSync(path.join(dir, n, 'x.mp3'), 'x');
  }
  assert.deepStrictEqual(
    invisibleFolders(dir, []).map((f) => f.folder),
    ['Alpha', 'Mid', 'Zed'],
  );
});

t('an unreadable music dir yields no findings, not a false alarm', () => {
  // An unreadable directory is a different problem and must not masquerade as
  // a silent one.
  assert.deepStrictEqual(invisibleFolders(path.join(os.tmpdir(), 'definitely-not-here-9f3'), []), []);
});

// --- auditReachability ------------------------------------------------------

t('the audit reports what it checked, so a clean result is verifiable', () => {
  const dir = tmpLibrary();
  const resolverFiles = [path.join('Seen Album', 'a.mp3'), 'loose.mp3'];
  const r = auditReachability({
    musicDir: dir,
    resolverFiles,
    referenced: [path.join('Seen Album', 'a.mp3')],
  });
  assert.strictEqual(r.musicDir, dir);
  assert.strictEqual(r.libraryFiles, 2);
  assert.strictEqual(r.namedByAnAlbum, 1);
  assert.strictEqual(r.unreached.total, 1);
  assert.deepStrictEqual(r.unreached.byFolder, [{ folder: '(root level)', files: 1 }]);
  assert.strictEqual(r.unreached.neverPlayed, null, 'null without a ledger, not 0');
  assert.ok(Array.isArray(r.invisibleFolders.folders));
  assert.ok(Date.parse(r.checkedAt) > 0, 'checkedAt must be a real timestamp');
});

t('neverPlayed is asked of the ledger, not guessed', () => {
  const dir = tmpLibrary();
  const ledger = { neverPlayedCount: (files) => files.length - 1 };
  const r = auditReachability({
    musicDir: dir,
    resolverFiles: ['a.mp3', 'b.mp3', 'c.mp3'],
    referenced: [],
    ledger,
  });
  assert.strictEqual(r.unreached.total, 3);
  assert.strictEqual(r.unreached.neverPlayed, 2);
});

t('an audit over an empty station is clean rather than throwing', () => {
  const r = auditReachability({ musicDir: fs.mkdtempSync(path.join(os.tmpdir(), 'reach-mt-')) });
  assert.strictEqual(r.libraryFiles, 0);
  assert.strictEqual(r.unreached.total, 0);
  assert.deepStrictEqual(r.invisibleFolders.folders, []);
});

// --- AUDIO_RE ---------------------------------------------------------------

t('every format the station actually serves counts as audio', () => {
  for (const f of ['a.mp3', 'a.MP3', 'a.wav', 'a.flac', 'a.m4a', 'a.ogg']) {
    assert.ok(AUDIO_RE.test(f), `${f} should count as audio`);
  }
  for (const f of ['a.txt', 'a.jpg', 'a.mp3.bak', 'cover.png']) {
    assert.ok(!AUDIO_RE.test(f), `${f} should not count as audio`);
  }
});

if (failed) {
  console.log(`\naudio-reachability: ${failed} FAILED`);
  process.exit(1);
}
console.log('\nAll audio-reachability tests passed');
