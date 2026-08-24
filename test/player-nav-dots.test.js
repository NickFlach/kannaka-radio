/**
 * player-nav-dots.test.js
 *
 * The scroll-spy dots on /player used to pair with sections by array
 * index. That holds only while the two lists are the same length and the
 * same order — and they hadn't been for a while: Air Time shipped without
 * a dot, so scrolling through Air Time lit the Gate's dot and the Gate lit
 * nothing at all.
 *
 * These checks run the REAL updateNavDots() out of workspace/index.html
 * against a stub DOM, rather than asserting on the source text — a source
 * check would pass for any function that merely mentions `href`.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const INDEX = fs.readFileSync(
  path.join(__dirname, "..", "workspace", "index.html"), "utf8");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.message}`); }
}

// ── Pull the real markup + the real function out of the page ──────────

/** hrefs of the nav dots, in page order. */
function navDotHrefs() {
  const nav = INDEX.match(/<nav class="section-nav">([\s\S]*?)<\/nav>/);
  assert.ok(nav, "no .section-nav block in index.html");
  return [...nav[1].matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
}

/** ids of the scrollable `.layer` sections, in page order. */
function layerSectionIds() {
  return [...INDEX.matchAll(/<section class="layer" id="([^"]+)"/g)].map((m) => m[1]);
}

/** Source of a top-level `function <name>() { ... }`, brace-matched. */
function functionSource(name) {
  const start = INDEX.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name} not found in index.html`);
  let i = INDEX.indexOf("{", start), depth = 0;
  for (let j = i; j < INDEX.length; j++) {
    if (INDEX[j] === "{") depth++;
    else if (INDEX[j] === "}") { depth--; if (depth === 0) return INDEX.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const HREFS = navDotHrefs();
const SECTION_IDS = layerSectionIds();
const SECTION_H = 1000;

/**
 * Build a stub DOM holding the page's real sections and dots, run the real
 * updateNavDots() at the given scroll position, and report which dots lit.
 */
function activeDotsAtScroll(scrollY, innerHeight = 900) {
  const dots = HREFS.map((h) => {
    const classes = new Set();
    return {
      href: h,
      getAttribute: (a) => (a === "href" ? "#" + h : null),
      classList: {
        toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
      },
      isActive: () => classes.has("active"),
    };
  });
  // Sections stacked top to bottom, uniform height.
  const sections = {};
  SECTION_IDS.forEach((id, i) => {
    sections[id] = { id, offsetTop: i * SECTION_H, offsetHeight: SECTION_H };
  });

  const sandbox = {
    document: {
      querySelectorAll: (sel) => {
        if (sel === ".section-nav a") return dots;
        if (sel === ".layer") return SECTION_IDS.map((id) => sections[id]);
        throw new Error("unexpected selector: " + sel);
      },
      getElementById: (id) => sections[id] || null,
    },
    window: { scrollY, innerHeight },
  };
  // Bare `window.scrollY` in the function resolves via the sandbox's
  // `window`; run the real source with those bindings.
  const run = new Function("document", "window", functionSource("updateNavDots") + "\nreturn updateNavDots();");
  run(sandbox.document, sandbox.window);
  return dots.filter((d) => d.isActive()).map((d) => d.href);
}

console.log("player nav dots");

check("every dot points at a section that exists", () => {
  for (const h of HREFS) {
    assert.ok(SECTION_IDS.includes(h),
      `dot #${h} points at no .layer section`);
  }
});

check("every scrollable section has a dot", () => {
  for (const id of SECTION_IDS) {
    assert.ok(HREFS.includes(id),
      `section #${id} has no nav dot — scrolling through it lights nothing`);
  }
});

check("scrolling through each section lights that section's own dot", () => {
  const innerHeight = 900;
  SECTION_IDS.forEach((id, i) => {
    // updateNavDots probes at scrollY + innerHeight/3; aim that probe at
    // the middle of section i.
    const probeWanted = i * SECTION_H + SECTION_H / 2;
    const scrollY = probeWanted - innerHeight / 3;
    const lit = activeDotsAtScroll(scrollY, innerHeight);
    assert.deepStrictEqual(lit, [id],
      `at section #${id} the lit dot(s) were [${lit.join(", ")}] — expected exactly [${id}]`);
  });
});

check("a section with no dot doesn't steal a neighbour's highlight", () => {
  // The original defect in miniature: drop one dot and every section below
  // it used to shift onto the wrong dot. With href pairing, the orphaned
  // section simply lights nothing and its neighbours are untouched.
  const innerHeight = 900;
  const orphan = SECTION_IDS[SECTION_IDS.length - 2];
  const survivors = HREFS.filter((h) => h !== orphan);
  SECTION_IDS.forEach((id, i) => {
    const scrollY = i * SECTION_H + SECTION_H / 2 - innerHeight / 3;
    // Re-run with the orphan's dot removed.
    const lit = (function () {
      const saved = HREFS.slice();
      HREFS.length = 0; HREFS.push(...survivors);
      try { return activeDotsAtScroll(scrollY, innerHeight); }
      finally { HREFS.length = 0; HREFS.push(...saved); }
    })();
    const expected = id === orphan ? [] : [id];
    assert.deepStrictEqual(lit, expected,
      `with #${orphan}'s dot removed, section #${id} lit [${lit.join(", ")}]`);
  });
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
