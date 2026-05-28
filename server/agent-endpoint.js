/**
 * server/agent-endpoint.js — JSON / SSE surface for the swarm inbox.
 *
 * The /agent HTML page itself lives at workspace/agent.html (the
 * Greenroom) — restored to its original role plus an embedded Inbox
 * Console that talks to these two endpoints:
 *
 *   POST /agent/send   JSON { to, verb, args, from? } → shells
 *                      `kannaka inbox send` and returns the published
 *                      payload
 *   GET  /agent/audit  Server-Sent Events stream; each NATS
 *                      KANNAKA.inbox.audit message lands as one
 *                      `data: <json>\n\n` frame
 *
 * The audit stream spawns one `kannaka inbox tail` child per connected
 * browser; cleaned up on socket close.
 *
 * No auth on this surface — it's a local-net dev console. If we ever
 * expose /agent on the public radio domain with sensitive verbs in the
 * handlers.toml, this should grow a token.
 */

"use strict";

const { spawn, execFile } = require("child_process");
const path = require("path");

const KANNAKA_BIN = process.env.KANNAKA_BIN ||
  path.join(__dirname, "..", "..", "kannaka-memory", "target", "release",
    process.platform === "win32" ? "kannaka.exe" : "kannaka");

const RADIO_URL = process.env.RADIO_PUBLIC_URL || "https://radio.ninja-portal.com";

function json(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Skill-registry snapshot served at /agent/skills. Returns `{}` when
 * no nats client has been wired in (e.g. minimal dev deploy).
 */
let _natsClient = null;
function attachNatsClient(client) { _natsClient = client; }

function inboxSend({ to, verb, args, from }) {
  const cli = [KANNAKA_BIN, "inbox", "send", to, verb];
  if (from) cli.push("--from", from);
  for (const [k, v] of Object.entries(args || {})) {
    cli.push("--arg", `${k}=${v}`);
  }
  return new Promise((resolve, reject) => {
    execFile(cli[0], cli.slice(1), { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message));
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        reject(new Error(`bad stdout: ${e.message}; raw=${stdout.slice(0, 200)}`));
      }
    });
  });
}


/**
 * Returns true if the request was handled by an /agent route.
 * Designed to be called from routes.js inside the main request handler.
 */
async function handleAgentRequest(req, res, parsed) {
  if (parsed.pathname === "/agent/skills" && req.method === "GET") {
    const snapshot = _natsClient && typeof _natsClient.skillsSnapshot === "function"
      ? _natsClient.skillsSnapshot()
      : {};
    json(res, 200, { skills: snapshot, count: Object.keys(snapshot).length });
    return true;
  }

  if (parsed.pathname === "/agent/peers" && req.method === "GET") {
    const peers = _natsClient && typeof _natsClient.peersSnapshot === "function"
      ? _natsClient.peersSnapshot()
      : [];
    json(res, 200, { peers, count: peers.length });
    return true;
  }

  if (parsed.pathname === "/agent/audit-history" && req.method === "GET") {
    const n = Math.max(1, Math.min(200, parseInt(parsed.searchParams.get("limit") || "40", 10) || 40));
    const events = _natsClient && typeof _natsClient.inboxAuditTail === "function"
      ? _natsClient.inboxAuditTail(n)
      : [];
    json(res, 200, { events, count: events.length });
    return true;
  }

  if (parsed.pathname === "/agent/send" && req.method === "POST") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return json(res, 400, { error: "bad json: " + e.message }), true;
    }
    if (!body || !body.to || !body.verb) {
      return json(res, 400, { error: "to and verb are required" }), true;
    }
    try {
      const result = await inboxSend({
        to: String(body.to),
        verb: String(body.verb),
        args: body.args || {},
        from: body.from ? String(body.from) : undefined,
      });
      return json(res, 200, result), true;
    } catch (e) {
      return json(res, 500, { error: e.message }), true;
    }
  }

  if (parsed.pathname === "/agent/audit") {
    // Server-Sent Events — one child kannaka-inbox-tail per connection.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering if fronted
    });
    res.write("retry: 5000\n\n");
    const child = spawn(KANNAKA_BIN, ["inbox", "tail"], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const flush = () => {
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          res.write("data: " + line + "\n\n");
        }
      }
    };
    child.stdout.on("data", (c) => { buf += c.toString("utf8"); flush(); });
    child.stderr.on("data", () => { /* swallow stderr from the tail child */ });
    const cleanup = () => {
      try { child.kill("SIGTERM"); } catch (_) {}
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
    child.on("exit", () => {
      try { res.end(); } catch (_) {}
    });
    return true;
  }

  return false;
}

module.exports = { handleAgentRequest, attachNatsClient };
