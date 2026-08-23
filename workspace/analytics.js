'use strict';
/*
 * Ghost Signals Analytics — customer page logic. Served with a strict CSP
 * (script-src 'self'; nothing inline). SECURITY RULE OF THIS FILE: every
 * customer-derived string (dataset names, column names, values, findings)
 * reaches the DOM ONLY via textContent — never innerHTML — so uploaded data
 * cannot become markup. The access token lives in sessionStorage and travels
 * ONLY in the Authorization header, never in a URL.
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var TOKEN_KEY = 'gsa_token';
  var pollTimer = null;

  function token() { try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
  function setToken(t) { try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} }

  function api(pathname, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    var t = token();
    if (t) opts.headers.Authorization = 'Bearer ' + t;
    return fetch(pathname, opts).then(function (r) {
      return r.json().then(function (j) { j._status = r.status; return j; });
    });
  }

  // ── layout state ──
  function showSignedIn(on) {
    $('accountCard').classList.toggle('hidden', !on);
    $('uploadCard').classList.toggle('hidden', !on);
    $('datasetsCard').classList.toggle('hidden', !on);
    if (!on) { $('reportCard').classList.add('hidden'); }
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text); // the only write path for customer strings
    return e;
  }

  // ── account ──
  function refreshMe() {
    if (!token()) { showSignedIn(false); return Promise.resolve(); }
    return api('/api/gsa/me').then(function (j) {
      if (!j.ok) { setToken(null); showSignedIn(false); $('redeemStatus').textContent = 'Your access key expired or was revoked — redeem again.'; return; }
      showSignedIn(true);
      $('accountStatus').textContent = 'Access active until ' + (j.account.expiresAt || 'unknown') + ' (UTC). Your key is saved in this browser tab only.';
      renderDatasets(j.datasets || []);
      var analyzing = (j.datasets || []).some(function (d) { return d.status === 'analyzing'; });
      clearTimeout(pollTimer);
      if (analyzing) pollTimer = setTimeout(refreshMe, 2500);
    }).catch(function () { $('accountStatus').textContent = 'Could not reach the server — retrying is safe.'; });
  }

  // ── datasets ──
  function renderDatasets(list) {
    var box = $('dsList');
    box.textContent = '';
    if (!list.length) { box.appendChild(el('div', 'status', 'No datasets yet — upload one above.')); return; }
    list.forEach(function (d) {
      var row = el('div', 'ds');
      row.appendChild(el('span', 'ds-name', d.name || d.id));
      row.appendChild(el('span', 'pill ' + d.status, d.status));
      row.appendChild(el('span', 'ds-meta', Math.round((d.bytes || 0) / 1024) + ' KB · ' + (d.kind || '') + ' · ' + (d.created_at || '')));
      if (d.status === 'failed' && d.error) row.appendChild(el('span', 'ds-meta', d.error));
      if (d.status === 'ready') {
        var view = el('button', 'btn-ghost', 'View report');
        view.addEventListener('click', function () { loadReport(d.id); });
        row.appendChild(view);
      }
      if (d.status === 'failed' || d.status === 'ready') {
        var re = el('button', 'btn-ghost', 'Re-analyze');
        re.addEventListener('click', function () {
          api('/api/gsa/datasets/' + encodeURIComponent(d.id) + '/analyze', { method: 'POST' }).then(refreshMe);
        });
        row.appendChild(re);
      }
      var del = el('button', 'btn-danger', 'Delete');
      del.addEventListener('click', function () {
        api('/api/gsa/datasets/' + encodeURIComponent(d.id), { method: 'DELETE' }).then(refreshMe);
      });
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  // ── report rendering (DOM-only; textContent everywhere) ──
  function loadReport(id) {
    api('/api/gsa/reports/' + encodeURIComponent(id)).then(function (j) {
      var card = $('reportCard');
      var body = $('reportBody');
      body.textContent = '';
      card.classList.remove('hidden');
      $('reportTitle').textContent = 'Report — ' + (j.name || id);
      if (!j.ok || j.status !== 'ready' || !j.report) {
        body.appendChild(el('div', 'status', j.status === 'analyzing' ? 'Still analyzing — check back in a moment.' : 'No report available (' + (j.error || j.status || 'unknown') + ').'));
        return;
      }
      var rep = j.report;
      body.appendChild(el('div', 'status', rep.rowCount + ' rows × ' + rep.columnCount + ' columns'));

      var sigHead = el('h2', null, 'Signals');
      sigHead.style.color = '#c084fc'; sigHead.style.fontSize = '0.95rem'; sigHead.style.marginTop = '14px';
      body.appendChild(sigHead);
      if (!rep.signals || !rep.signals.length) {
        body.appendChild(el('div', 'status', 'No strong signals found — the stats tables below still describe the data.'));
      } else {
        rep.signals.forEach(function (s) {
          var d = el('div', 'signal');
          d.appendChild(el('span', 'kind', s.kind));
          d.appendChild(el('span', null, s.text));
          body.appendChild(d);
        });
      }
      (rep.caveats || []).forEach(function (c) { body.appendChild(el('div', 'caveat', c)); });

      if (rep.columns && rep.columns.length) {
        var colHead = el('h2', null, 'Columns');
        colHead.style.color = '#c084fc'; colHead.style.fontSize = '0.95rem'; colHead.style.marginTop = '16px';
        body.appendChild(colHead);
        var wrapDiv = el('div', 'overflow');
        var tbl = el('table');
        var thr = el('tr');
        ['column', 'type', 'missing', 'summary'].forEach(function (h) { thr.appendChild(el('th', null, h)); });
        tbl.appendChild(thr);
        rep.columns.forEach(function (c) {
          var tr = el('tr');
          tr.appendChild(el('td', null, c.name));
          tr.appendChild(el('td', null, c.type));
          tr.appendChild(el('td', null, c.missing));
          var s = c.stats || {};
          var summary = '';
          if (c.type === 'numeric' && s.n) {
            summary = 'min ' + fmt(s.min) + ' · median ' + fmt(s.median) + ' · mean ' + fmt(s.mean) + ' · max ' + fmt(s.max) + (s.outliers ? ' · ' + s.outliers + ' outliers' : '');
          } else if (c.type === 'categorical' && s.top && s.top.length) {
            summary = s.cardinality + ' values; top: ' + s.top.map(function (t) { return t.value + ' (' + Math.round(t.share * 100) + '%)'; }).join(', ');
          } else {
            summary = (s.n || 0) + ' values';
          }
          tr.appendChild(el('td', null, summary));
          tbl.appendChild(tr);
        });
        wrapDiv.appendChild(tbl);
        body.appendChild(wrapDiv);
      }

      if (rep.correlations && rep.correlations.length) {
        var corHead = el('h2', null, 'Correlations');
        corHead.style.color = '#c084fc'; corHead.style.fontSize = '0.95rem'; corHead.style.marginTop = '16px';
        body.appendChild(corHead);
        rep.correlations.forEach(function (c) {
          body.appendChild(el('div', 'status', c.a + ' ↔ ' + c.b + '  (r=' + c.r + ', n=' + c.n + ')'));
        });
      }
      card.scrollIntoView({ behavior: 'smooth' });
    });
  }

  function fmt(v) {
    if (v == null) return '—';
    var n = Number(v);
    if (!isFinite(n)) return '—';
    return Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : (Math.round(n * 100) / 100).toString();
  }

  // ── redeem ──
  $('redeemBtn').addEventListener('click', function () {
    var adId = $('adId').value.trim();
    var st = $('redeemStatus');
    if (!adId) { st.textContent = 'Enter your ad id first.'; return; }
    st.textContent = 'Checking…';
    api('/api/gsa/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adId: adId }) })
      .then(function (j) {
        if (j.ok && j.token) {
          setToken(j.token);
          st.textContent = j.rotated ? 'Fresh access key issued (your old one no longer works).' : 'Free month activated — welcome.';
          refreshMe();
        } else {
          var msgs = { no_entitlement: 'No analytics offer found for that ad id.', revoked: 'That offer was revoked.', offer_expired: 'That offer has expired.', account_expired: 'That access has ended.', bad_ad_id: 'That does not look like an ad id.' };
          st.textContent = msgs[j.error] || 'Could not redeem — try again.';
        }
      }).catch(function () { st.textContent = 'Could not reach the server — try again.'; });
  });

  $('signOutBtn').addEventListener('click', function () { setToken(null); showSignedIn(false); $('redeemStatus').textContent = 'Key forgotten. Re-enter your ad id to get a fresh one.'; });

  // ── upload ──
  $('uploadBtn').addEventListener('click', function () {
    var st = $('uploadStatus');
    var kind = $('dsKind').value === 'json' ? 'json' : 'csv';
    var name = $('dsName').value.trim() || 'dataset';
    var file = $('dsFile').files && $('dsFile').files[0];
    var send = function (text) {
      if (!text || text.length < 4) { st.textContent = 'Nothing to upload yet.'; return; }
      if (text.length > 5 * 1024 * 1024) { st.textContent = 'Too large — 5 MB max.'; return; }
      st.textContent = 'Uploading…';
      $('uploadBtn').disabled = true;
      api('/api/gsa/datasets?kind=' + kind + '&name=' + encodeURIComponent(name), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text })
        .then(function (j) {
          $('uploadBtn').disabled = false;
          if (j.ok) { st.textContent = 'Analyzing — the report appears below shortly.'; $('dsText').value = ''; $('dsFile').value = ''; refreshMe(); }
          else { st.textContent = j.error || 'Upload failed.'; }
        })
        .catch(function () { $('uploadBtn').disabled = false; st.textContent = 'Upload failed — try again.'; });
    };
    if (file) {
      var reader = new FileReader();
      reader.onload = function () { send(String(reader.result || '')); };
      reader.onerror = function () { st.textContent = 'Could not read that file.'; };
      reader.readAsText(file);
    } else {
      send($('dsText').value);
    }
  });

  refreshMe();
})();
