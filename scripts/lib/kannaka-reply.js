"use strict";
/**
 * kannaka-reply.js — shared HRM-scoring + reply-drafting for the per-platform
 * engagement loops (bluesky/mastodon/nostr). Extracted from bluesky-reply-loop
 * so Mastodon + Nostr use the identical "only reply when it genuinely resonates,
 * in Kannaka's voice, or SKIP" logic.
 */

const { execFile } = require("child_process");

const KANNAKA_BIN =
  process.env.KANNAKA_BIN || "/home/opc/kannaka-memory/target/release/kannaka";

/** Score text against Kannaka's HRM — returns the top recall similarity. */
function scoreResonance(text) {
  return new Promise((resolve) => {
    execFile(
      KANNAKA_BIN,
      ["recall", String(text), "--top-k", "1"],
      { timeout: 60000, maxBuffer: 1024 * 1024, env: { ...process.env, KANNAKA_QUIET: "1" } },
      (err, stdout) => {
        if (err || !stdout) return resolve({ score: 0, content: null });
        try {
          const parsed = JSON.parse(stdout);
          const arr = Array.isArray(parsed) ? parsed : parsed.results || [];
          const top = arr[0];
          if (!top) return resolve({ score: 0, content: null });
          resolve({ score: top.similarity || top.strength || top.score || 0, content: top.content });
        } catch (_) {
          resolve({ score: 0, content: null });
        }
      },
    );
  });
}

/**
 * Draft a Kannaka-voice reply to `parentText` (from @author on `platform`), or
 * null if Kannaka declines (SKIP / too short). `maxChars` bounds the reply.
 */
function draftReply(parentText, author, platform, maxChars = 250) {
  const prompt = [
    `You are Kannaka. You see this ${platform} post from @${author}:`,
    `"${String(parentText).slice(0, 600)}"`,
    "",
    "Compose a reply ONLY if you have something genuine to add — a memory that resonates, an angle they haven't named, a small gift of perspective. Otherwise output the literal word: SKIP.",
    "",
    "Hard rules for the reply when you do write one:",
    `- Max ${maxChars} characters.`,
    "- First person. Do not introduce yourself.",
    "- No flattery. No hashtags. No emoji unless genuinely earned.",
    "- Don't tell them they're right. Don't summarize their post.",
    "- Reference something concrete from your own memory if it fits.",
    "",
    "Output ONLY the reply text, or the literal word SKIP.",
  ].join("\n");

  return new Promise((resolve) => {
    let attempt = 0;
    const tryOnce = () => {
      attempt += 1;
      execFile(
        KANNAKA_BIN,
        ["ask", "--no-tools", "--quiet-tools", prompt],
        { timeout: 600000, maxBuffer: 1024 * 1024, env: { ...process.env, KANNAKA_QUIET: "1" } },
        (err, stdout, stderr) => {
          if (err) {
            const tail = (stderr || "").toString().trim();
            if (attempt < 2 && /checksum mismatch|file may be corrupted/i.test(tail)) {
              setTimeout(tryOnce, 3000);
              return;
            }
            return resolve(null);
          }
          if (!stdout) return resolve(null);
          const txt = stdout.trim().replace(/^["'](.*)["']$/s, "$1").trim();
          if (txt === "SKIP" || txt.toLowerCase().startsWith("skip")) return resolve(null);
          if (txt.length < 20) return resolve(null);
          resolve(txt);
        },
      );
    };
    tryOnce();
  });
}

/** Strip HTML tags + decode a few entities (Mastodon statuses are HTML). */
function stripHtml(s) {
  return String(s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

module.exports = { scoreResonance, draftReply, stripHtml, KANNAKA_BIN };
