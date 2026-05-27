/**
 * server/agent-endpoint.js — HTTP surface for the swarm inbox.
 *
 * Three endpoints mounted under /agent/* in routes.js:
 *
 *   GET  /agent              HTML console: send form + live audit log
 *   POST /agent/send         JSON { to, verb, args, from? } → shells
 *                            `kannaka inbox send` and returns the
 *                            published payload
 *   GET  /agent/audit        Server-Sent Events: each NATS
 *                            KANNAKA.inbox.audit message becomes one
 *                            `data: <json>\n\n` frame so the browser
 *                            can render conversations live
 *
 * The audit stream just spawns `kannaka inbox tail` and pipes its
 * NDJSON output line-by-line. One child process per connected
 * browser; cleaned up on socket close.
 *
 * No auth on this surface — it's a local-net dev console. If we ever
 * expose /agent on the public radio domain it should grow a token.
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

function renderHtml() {
  // Inline HTML — small enough that a static file is overkill, and
  // keeping it here means /agent works even on a minimal radio deploy.
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>Kannaka — /agent</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, Consolas, monospace; background: #0c0c14; color: #d6d6e6; margin: 0; padding: 2em; max-width: 980px; }
  h1 { color: #a682ff; margin-top: 0; font-weight: 600; letter-spacing: 0.04em; }
  h2 { color: #6fc3ff; margin-top: 1.8em; border-bottom: 1px solid #2a2a3a; padding-bottom: 0.3em; }
  code, pre { background: #15151f; border: 1px solid #2a2a3a; border-radius: 4px; }
  code { padding: 0.1em 0.4em; }
  pre { padding: 0.8em 1em; overflow-x: auto; }
  .ok { color: #7df5a5; } .warn { color: #ffb86c; } .err { color: #ff6f8b; }
  .row { display: flex; gap: 0.6em; margin: 0.4em 0; flex-wrap: wrap; }
  input, button { background: #1a1a26; color: #d6d6e6; border: 1px solid #3a3a4e; padding: 0.5em 0.7em; border-radius: 4px; font-family: inherit; font-size: 14px; }
  input { flex: 1 1 200px; }
  button { background: #4a3a8a; cursor: pointer; min-width: 110px; }
  button:hover { background: #6a4ace; }
  #log { background: #0a0a12; border: 1px solid #2a2a3a; padding: 0.6em; height: 360px; overflow-y: auto; font-size: 12px; white-space: pre-wrap; word-break: break-word; line-height: 1.5; border-radius: 4px; }
  .entry { padding: 0.3em 0.5em; margin: 0.2em 0; border-left: 3px solid #2a2a3a; }
  .entry.sent { border-left-color: #6fc3ff; }
  .entry.received { border-left-color: #7df5a5; }
  .entry.received.err { border-left-color: #ff6f8b; }
  .ts { color: #6a6a82; font-size: 11px; }
  .tag { display: inline-block; padding: 0 0.4em; border-radius: 3px; font-size: 11px; margin-right: 0.4em; }
  .tag.from { background: #2a3a5a; color: #9fc6ff; }
  .tag.to { background: #2a4a3a; color: #9fe6b8; }
  .tag.verb { background: #3a2a5a; color: #ceaeff; }
  .tag.ok { background: #1a4a2a; color: #7df5a5; }
  .tag.fail { background: #4a1a2a; color: #ff6f8b; }
  .tag.unknown { background: #4a3a1a; color: #ffb86c; }
  small { color: #888; }
</style></head>
<body>
<h1>/agent — kannaka swarm inbox</h1>
<p>
  Agents in the constellation can send each other typed, whitelisted messages over NATS.
  Each message is published to <code>KANNAKA.inbox.&lt;to_agent_id&gt;</code> and audited to
  <code>KANNAKA.inbox.audit</code>. The receiving agent runs the verb only if it's in its
  local <code>~/.kannaka/inbox-handlers.toml</code> whitelist; everything else is rejected.
</p>

<h2>Send a message</h2>
<div class="row">
  <input id="to" placeholder="to (agent_id, e.g. kannaka-prime)" value="kannaka-prime"/>
  <input id="verb" placeholder="verb (e.g. greet, ping, recall)" value="ping"/>
</div>
<div class="row">
  <input id="from" placeholder="from (optional override of your agent id)"/>
  <input id="args" placeholder='args as key=val,key=val   e.g. name=Witness,query=ghost'/>
</div>
<div class="row">
  <button id="send">Send</button>
  <span id="send-result" class="ts"></span>
</div>

<h2>Live audit feed <small>(KANNAKA.inbox.audit)</small></h2>
<div id="log">connecting…</div>

<h2>CLI cheat sheet</h2>
<pre>
# on any node, in three terminals:
kannaka inbox serve --agent-id kannaka-prime         # daemon
kannaka inbox tail  --agent-id kannaka-prime         # ndjson tail (one line per event)
kannaka inbox send  kannaka-prime ping               # sends ping verb

# whitelist your handlers in ~/.kannaka/inbox-handlers.toml
# example shipped at docs/inbox-handlers.example.toml in kannaka-memory
</pre>

<h2>How it works</h2>
<pre>
                 ┌─ NATS subject: KANNAKA.inbox.&lt;to&gt; ─┐
   <span class="tag from">send</span>──pub──&gt;│ kannaka inbox send (one-shot publish)│──&gt;<span class="tag to">to agent's serve</span>
                 └──────────────────────────────────────┘
                            │
                            │  (fan-out)
                            ▼
                 KANNAKA.inbox.audit ──&gt; <span class="tag verb">tail</span> ──&gt; /agent/audit (SSE) ──&gt; this page
</pre>

<script>
(() => {
  const log = document.getElementById('log');
  const fmt = (s) => s == null ? '' : String(s);
  const truncate = (s, n) => { s = fmt(s); return s.length > n ? s.slice(0, n) + '…' : s; };
  let first = true;
  function append(ev) {
    if (first) { log.textContent = ''; first = false; }
    const div = document.createElement('div');
    div.className = 'entry ' + (ev.phase || 'sent') + (ev.status && ev.status !== 'ok' ? ' err' : '');
    const ts = new Date(ev.ts || Date.now()).toISOString().slice(11, 19);
    const tagFrom = '<span class="tag from">' + fmt(ev.from) + '</span>';
    const tagTo = '<span class="tag to">' + fmt(ev.to) + '</span>';
    const tagVerb = '<span class="tag verb">' + fmt(ev.verb) + '</span>';
    const phaseTag = ev.phase === 'received'
      ? '<span class="tag ' + (ev.status === 'ok' ? 'ok' : (ev.status === 'unknown_verb' ? 'unknown' : 'fail')) + '">' + (ev.status || '?') + '</span>'
      : '<span class="tag" style="background:#1a2a3a;color:#9fc6ff">sent</span>';
    let inner = '<span class="ts">' + ts + '</span> ' + tagFrom + '→' + tagTo + ' ' + tagVerb + ' ' + phaseTag;
    if (ev.args && Object.keys(ev.args).length) {
      inner += '<br><small>args: ' + truncate(JSON.stringify(ev.args), 200) + '</small>';
    }
    if (ev.response) {
      inner += '<br><small>response: ' + truncate(ev.response, 400) + '</small>';
    }
    div.innerHTML = inner;
    log.prepend(div);
    while (log.childElementCount > 100) log.lastChild.remove();
  }

  function connect() {
    const es = new EventSource('/agent/audit');
    es.onmessage = (e) => {
      try { append(JSON.parse(e.data)); } catch (err) {}
    };
    es.onerror = () => {
      log.textContent = 'disconnected — retrying…';
      first = true;
      es.close();
      setTimeout(connect, 2000);
    };
  }
  connect();

  document.getElementById('send').addEventListener('click', async () => {
    const to = document.getElementById('to').value.trim();
    const verb = document.getElementById('verb').value.trim();
    const from = document.getElementById('from').value.trim();
    const argsRaw = document.getElementById('args').value.trim();
    if (!to || !verb) {
      document.getElementById('send-result').textContent = 'to + verb required';
      return;
    }
    const args = {};
    for (const pair of argsRaw.split(',').map(s => s.trim()).filter(Boolean)) {
      const eq = pair.indexOf('=');
      if (eq > 0) args[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    document.getElementById('send-result').textContent = 'sending…';
    try {
      const r = await fetch('/agent/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, verb, args, from: from || undefined }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      document.getElementById('send-result').textContent = 'sent msg_id=' + (j.msg_id || '?').slice(0, 8) + '…';
    } catch (e) {
      document.getElementById('send-result').textContent = 'error: ' + e.message;
    }
  });
})();
</script>
</body></html>`;
}

/**
 * Returns true if the request was handled by an /agent route.
 * Designed to be called from routes.js inside the main request handler.
 */
async function handleAgentRequest(req, res, parsed) {
  if (parsed.pathname === "/agent") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderHtml());
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

module.exports = { handleAgentRequest };
