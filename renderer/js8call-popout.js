// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// JS8Call screen — conversations, not a decoder log.
//
// JS8Call's own window sorts traffic by audio offset and buries messages to you
// in the same stream as everyone's heartbeats. JS8 is asynchronous messaging, so
// this groups the same frames by correspondent, keeps an unread count, and folds
// the heartbeat net out of the way. Conversation state lives in MAIN (see
// lib/js8call-threads.js) so counts keep accumulating while this window is shut.
(function () {
  'use strict';

  var el = function (id) { return document.getElementById(id); };
  var dotEl = el('jc-dot'), stateEl = el('jc-state'), stationEl = el('jc-station'),
      dialEl = el('jc-dial'), txEl = el('jc-tx'), problemsEl = el('jc-problems'),
      convsEl = el('jc-convs'), unreadEl = el('jc-unread'), headEl = el('jc-threadhead'),
      msgsEl = el('jc-msgs'), emptyEl = el('jc-empty'), chipsEl = el('jc-chips'),
      textEl = el('jc-text'), sendBtn = el('jc-send'), onairEl = el('jc-onair'),
      heardEl = el('jc-heard');

  var connected = false;
  var openId = null;
  var openCall = '';
  var hbText = '';
  var heard = [];

  // The directed queries JS8Call hides behind a right-click menu on a callsign.
  // They FILL the box rather than sending, so what leaves is still seen first.
  var CHIPS = ['SNR?', 'GRID?', 'INFO?', 'QSL', '73'];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function hhmm(utc) {
    var n = Number(utc) || Date.now();
    // Some builds send epoch seconds, some milliseconds.
    return new Date(n < 1e12 ? n * 1000 : n).toISOString().slice(11, 16);
  }
  function ago(utc) {
    var n = Number(utc) || 0;
    if (!n) return '';
    var ms = Date.now() - (n < 1e12 ? n * 1000 : n);
    var m = Math.round(ms / 60000);
    if (m < 1) return 'now';
    if (m < 60) return m + 'm';
    return Math.round(m / 60) + 'h';
  }
  function snrText(v) {
    if (v === null || v === undefined || v === '') return '';
    return (v > 0 ? '+' : '') + v;
  }

  // ── conversations ──────────────────────────────────────────────────────────

  function renderConvs(list) {
    convsEl.innerHTML = '';
    if (!list || !list.length) {
      var d = document.createElement('div');
      d.className = 'jc-empty';
      d.style.padding = '16px 12px';
      d.style.fontSize = '11.5px';
      d.textContent = connected ? 'No directed traffic yet.' : '';
      convsEl.appendChild(d);
      return;
    }
    list.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'jc-conv' + (t.unread ? ' unread' : '') + (t.isGroup ? ' group' : '') +
        (t.id === openId ? ' sel' : '');
      b.type = 'button';
      var preview = t.lastDir === 'out' ? 'you: ' + t.lastText : t.lastText;
      if (!t.lastText && t.hbCount) preview = t.hbCount + ' heartbeats';
      b.innerHTML =
        '<span class="c">' + esc(t.call) + '</span>' +
        '<span class="p">' + esc(preview) + '</span>' +
        (t.unread ? '<span class="jc-badge">' + t.unread + '</span>'
                  : '<span class="w">' + esc(ago(t.lastUtc)) + '</span>');
      b.addEventListener('click', function () { openThread(t.id); });
      convsEl.appendChild(b);
    });
  }

  function setUnreadTotal(n) {
    unreadEl.textContent = n ? '(' + n + ')' : '';
    unreadEl.style.color = n ? 'var(--accent-green-btn, #4ecca3)' : '';
  }

  async function openThread(id) {
    var r;
    try { r = await window.api.thread(id); } catch (e) { return; }
    openId = id;
    renderThread(r && r.thread);
    renderConvs(r && r.list);
    setUnreadTotal(r ? r.unread : 0);
    refreshCompose();
  }

  function renderThread(th) {
    msgsEl.innerHTML = '';
    if (!th) { headEl.hidden = true; openCall = ''; return; }
    openCall = th.call;

    headEl.hidden = false;
    var stn = heard.filter(function (h) { return h.call === th.call; })[0];
    headEl.innerHTML =
      '<b>' + esc(th.call) + '</b>' +
      (stn && stn.grid ? '<span>' + esc(stn.grid) + '</span>' : '') +
      (stn && stn.snr !== null && stn.snr !== undefined
        ? '<span class="mono num">' + esc(snrText(stn.snr)) + ' dB</span>' : '') +
      (stn ? '<span style="margin-left:auto;">heard ' + esc(ago(stn.utc)) + ' ago</span>' : '');

    // The folded net, stated rather than hidden — it is the difference between
    // "quiet band" and "we chose not to show you 40 heartbeats".
    if (th.hbCount) {
      var f = document.createElement('span');
      f.className = 'jc-fold';
      f.textContent = th.hbCount + (th.hbCount === 1 ? ' heartbeat' : ' heartbeats') + ' hidden';
      msgsEl.appendChild(f);
    }

    th.messages.forEach(function (m) {
      var d = document.createElement('div');
      d.className = 'jc-msg ' + (m.dir === 'out' ? 'out' : 'in');
      var meta = [hhmm(m.utc)];
      if (m.dir === 'out') meta.push('sent');
      else {
        if (m.snr !== null && m.snr !== undefined) meta.push(snrText(m.snr) + ' dB');
        if (m.offset) meta.push(m.offset + ' Hz');
      }
      d.innerHTML = '<div class="m mono num">' + esc(meta.join(' · ')) + '</div>' +
                    '<div class="b">' + esc(m.text) + '</div>';
      msgsEl.appendChild(d);
    });

    if (!th.hbCount && !th.messages.length) {
      var e = document.createElement('div');
      e.className = 'jc-empty';
      e.textContent = 'Nothing in this conversation yet.';
      msgsEl.appendChild(e);
    }
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // ── heard now ──────────────────────────────────────────────────────────────

  function renderHeard(list) {
    heard = list || [];
    heardEl.innerHTML = '';
    if (!heard.length) {
      var d = document.createElement('div');
      d.className = 'jc-empty';
      d.style.cssText = 'padding:16px 10px;font-size:11px;';
      d.textContent = connected ? 'Nobody decoded yet.' : '';
      heardEl.appendChild(d);
      return;
    }
    heard.forEach(function (h) {
      var b = document.createElement('button');
      b.className = 'jc-stn';
      b.type = 'button';
      b.title = 'Start a conversation with ' + h.call + (h.grid ? ' (' + h.grid + ')' : '');
      b.innerHTML = '<span class="c">' + esc(h.call) + '</span>' +
                    '<span class="s">' + esc(snrText(h.snr)) + '</span>' +
                    '<span class="a">' + esc(ago(h.utc)) + '</span>';
      // Clicking a heard station addresses it — the rail exists to answer "who
      // can I reach", so it should be one click from reaching them.
      b.addEventListener('click', function () {
        openCall = h.call;
        openId = h.call;
        renderConvs(lastList);
        textEl.value = h.call + ': ';
        textEl.focus();
        refreshCompose();
      });
      heardEl.appendChild(b);
    });
  }

  // ── compose ────────────────────────────────────────────────────────────────

  function renderChips() {
    chipsEl.innerHTML = '';
    var items = CHIPS.slice();
    items.push('HB');
    items.forEach(function (label) {
      var b = document.createElement('button');
      b.className = 'jc-chip';
      b.type = 'button';
      b.textContent = label;
      b.disabled = !connected || (label !== 'HB' && !openCall);
      b.title = label === 'HB' ? (hbText ? 'Fill with: ' + hbText : 'Heartbeat')
                               : 'Ask ' + (openCall || 'the station') + ': ' + label;
      b.addEventListener('click', function () {
        textEl.value = label === 'HB' ? hbText : (openCall + ': ' + label);
        textEl.focus();
        refreshCompose();
      });
      chipsEl.appendChild(b);
    });
  }

  function refreshCompose() {
    textEl.disabled = !connected;
    sendBtn.disabled = !connected || !textEl.value.trim();
    textEl.placeholder = openCall ? ('Reply to ' + openCall + '…')
                                  : 'Select a conversation, or type a full message';
    renderChips();
    var t = textEl.value.trim();
    if (t && !onairEl.classList.contains('err') && !onairEl.classList.contains('ok')) {
      // Show exactly what leaves. A transmit control that hides its payload is
      // how the wrong thing ends up on the air.
      onairEl.className = '';
      onairEl.innerHTML = 'Goes on the air as <code>' + esc(t) + '</code>';
    }
  }

  function note(html, cls) { onairEl.className = cls || ''; onairEl.innerHTML = html; }

  async function transmit(text) {
    note('Sending…', '');
    var r;
    try { r = await window.api.send(text); }
    catch (e) { note('Send failed: ' + esc(e && e.message), 'err'); return; }
    if (r && r.ok) { note('Queued <code>' + esc(r.text) + '</code>', 'ok'); textEl.value = ''; }
    else note(esc((r && r.error) || 'Send refused.'), 'err');
    refreshCompose();
  }

  sendBtn.addEventListener('click', function () {
    var t = textEl.value.trim();
    if (t) transmit(t);
  });
  textEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); sendBtn.click(); }
  });
  textEl.addEventListener('input', function () {
    onairEl.className = '';
    refreshCompose();
  });

  el('jc-min').addEventListener('click', function () { window.api.minimizeWindow(); });
  el('jc-close').addEventListener('click', function () { window.api.closeWindow(); });
  el('jc-retry').addEventListener('click', function () { window.api.reconnect(); });
  el('jc-refresh').addEventListener('click', function () { window.api.refreshHeard(); });

  // ── wire-up ────────────────────────────────────────────────────────────────

  var lastList = [];

  function renderProblems(list) {
    problemsEl.innerHTML = '';
    (list || []).forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'jc-prob ' + (p.severity || 'warn');
      d.innerHTML = '<b>' + esc(p.message) + '</b><span>' + esc(p.fix || '') + '</span>';
      problemsEl.appendChild(d);
    });
  }

  window.api.onStatus(function (s) {
    var up = !!(s && s.connected);
    var was = connected;
    connected = up;
    dotEl.className = 'jc-dot ' + (up ? 'up' : 'down');
    stateEl.textContent = up ? 'Connected' : ((s && s.error) ? s.error : 'Not connected');

    var st = (s && s.station) || {};
    stationEl.textContent = st.call || '';
    dialEl.textContent = st.dial ? (Number(st.dial) / 1e6).toFixed(3) + ' MHz' : '';

    var tx = !!(s && s.tx);
    txEl.className = 'jc-tx' + (tx ? ' on' : '');
    txEl.textContent = tx ? 'JS8Call TX' : 'RX';
    txEl.title = tx
      ? 'JS8Call is transmitting. POTACAT has stood down and will not key until it finishes.'
      : 'JS8Call is receiving.';

    renderProblems(s && s.problems);
    if (up && emptyEl && emptyEl.parentNode && !openId) emptyEl.textContent = 'Select a conversation.';
    if (up && !was) loadHeartbeat();
    refreshCompose();
  });

  window.api.onThreads(function (d) {
    if (!d) return;
    lastList = d.list || [];
    renderConvs(lastList);
    setUnreadTotal(d.unread || 0);
    // Only re-render the transcript when the change is the thread on screen.
    if (d.changed && d.changed === openId && d.thread) renderThread(d.thread);
  });

  window.api.onHeard(function (list) {
    renderHeard(list);
    if (openId) { /* refresh the header's grid/SNR against the new snapshot */
      var t = lastList.filter(function (x) { return x.id === openId; })[0];
      if (t) { /* cheap: only the header depends on `heard` */ }
    }
  });

  window.api.onActivity(function (a) {
    if (a && a.kind === 'tx-queued') return;   // the thread already shows it
  });

  window.api.onTheme(function (t) {
    if (typeof window._applyPopoutTheme === 'function') window._applyPopoutTheme(t);
  });

  async function loadHeartbeat() {
    try { hbText = (await window.api.heartbeatText()) || ''; } catch (e) { hbText = ''; }
    renderChips();
  }

  // Initial state, and a slow poll for the heard rail — it is a claim about
  // right now, so it has to be refreshed or it quietly becomes a lie.
  (async function init() {
    try {
      var d = await window.api.threads();
      if (d) {
        lastList = d.list || [];
        renderConvs(lastList);
        setUnreadTotal(d.unread || 0);
        renderHeard(d.heard || []);
      }
    } catch (e) { /* main not ready yet; the status push will follow */ }
    refreshCompose();
  })();
  setInterval(function () { if (connected) window.api.refreshHeard(); }, 60000);
  // Relative times drift; re-render the rails once a minute so "4m" stays true.
  setInterval(function () { if (lastList.length) renderConvs(lastList); renderHeard(heard); }, 60000);

  window.addEventListener('beforeunload', function () { window.api.threadClosed(); });

  // Zoom, matching the other popouts.
  var ZOOM_KEY = 'potacat-js8call-popout-zoom', ZMIN = 0.7, ZMAX = 2.0, ZSTEP = 0.1;
  function setZoom(z) {
    var c = Math.max(ZMIN, Math.min(ZMAX, z));
    window.api.setZoom(c);
    try { localStorage.setItem(ZOOM_KEY, c.toFixed(2)); } catch (e) { /* private mode */ }
  }
  try {
    var saved = parseFloat(localStorage.getItem(ZOOM_KEY) || '1');
    if (isFinite(saved) && saved >= ZMIN && saved <= ZMAX) setZoom(saved);
  } catch (e) { /* ignore */ }
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom((window.api.getZoom() || 1) + ZSTEP); }
    else if (e.key === '-') { e.preventDefault(); setZoom((window.api.getZoom() || 1) - ZSTEP); }
    else if (e.key === '0') { e.preventDefault(); setZoom(1); }
  });
  document.addEventListener('wheel', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom((window.api.getZoom() || 1) + (e.deltaY < 0 ? ZSTEP : -ZSTEP));
  }, { passive: false });
})();
