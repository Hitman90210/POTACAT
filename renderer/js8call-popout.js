// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// JS8 screen — conversations, not a decoder log.
//
// JS8 is asynchronous messaging, so this groups frames by correspondent,
// keeps an unread count, and folds the heartbeat net out of the way.
// Conversation state lives in MAIN (lib/js8call-threads.js) so counts keep
// accumulating while this window is shut.
//
// JS8 itself is native (lib/js8-engine.js under JTCAT): Start runs it, Stop
// stops it, and there is nothing else to configure — the setup flow this
// window used to carry (JS8Call.ini patching, DAX, slices, virtual audio
// cables) died with the bridge. docs/js8-native-plan.md records the whole
// arc.
(function () {
  'use strict';

  var el = function (id) { return document.getElementById(id); };
  var dotEl = el('jc-dot'), stateEl = el('jc-state'), stationEl = el('jc-station'),
      submodeEl = el('jc-submode'), txEl = el('jc-tx'), actsEl = el('jc-acts'),
      powerBtn = el('jc-power'), cqBtn = el('jc-cq'), hbBtn = el('jc-hb'),
      convsEl = el('jc-convs'), groupsEl = el('jc-groups'), unreadEl = el('jc-unread'),
      headEl = el('jc-threadhead'), colsEl = el('jc-cols'), toEl = el('jc-to'),
      msgsEl = el('jc-msgs'), chipsEl = el('jc-chips'),
      textEl = el('jc-text'), sendBtn = el('jc-send'), onairEl = el('jc-onair'),
      heardEl = el('jc-heard');

  var setupEl = el('jc-setup'), setupStart = el('jc-setup-start'),
      setupErr = el('jc-setup-err'), speedEl = el('jc-speed'), hbMinEl = el('jc-hb-min');

  var running = false;
  var hbOn = false;
  var openId = null;
  var openCall = '';
  var heard = [];
  var lastList = [];

  // Directed queries, one tap. They FILL the box rather than sending, so
  // what leaves is still seen first.
  var CHIPS = ['SNR?', 'GRID?', 'INFO?', 'QSL', '73'];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function hhmm(utc) {
    var n = Number(utc) || Date.now();
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

  function renderConvs(all) {
    renderGroups(all);
    renderTo(all);
    // Individuals only — groups have their own rail above.
    var list = (all || []).filter(function (t) { return !t.isGroup; });
    convsEl.innerHTML = '';
    if (!list.length) {
      var d = document.createElement('div');
      d.className = 'jc-empty';
      d.style.padding = '16px 12px';
      d.style.fontSize = '11.5px';
      d.textContent = running ? 'No directed traffic yet.' : '';
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

  // ── groups ─────────────────────────────────────────────────────────────────
  var BASE_GROUPS = ['@ALLCALL', '@HB'];

  function knownGroups(list) {
    var seen = {};
    BASE_GROUPS.forEach(function (g) { seen[g] = true; });
    (list || []).forEach(function (t) { if (t.isGroup && t.call) seen[t.call] = true; });
    return Object.keys(seen).sort(function (a, b) {
      var ai = BASE_GROUPS.indexOf(a), bi = BASE_GROUPS.indexOf(b);
      if (ai >= 0 || bi >= 0) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      return a.localeCompare(b);
    });
  }

  function renderGroups(list) {
    groupsEl.innerHTML = '';
    var byId = {};
    (list || []).forEach(function (t) { byId[t.call] = t; });
    knownGroups(list).forEach(function (g) {
      var t = byId[g] || { id: g, call: g, unread: 0, lastText: '', isGroup: true };
      var b = document.createElement('button');
      b.className = 'jc-conv group' + (t.unread ? ' unread' : '') + (t.id === openId ? ' sel' : '');
      b.type = 'button';
      b.innerHTML = '<span class="c">' + esc(g) + '</span>' +
        '<span class="p">' + esc(t.lastText || '') + '</span>' +
        (t.unread ? '<span class="jc-badge">' + t.unread + '</span>' : '');
      b.addEventListener('click', function () { openThread(t.id); });
      groupsEl.appendChild(b);
    });
  }

  /** Destinations for the compose row, current selection preserved. */
  function renderTo(list) {
    var want = toEl.value || openCall || '@ALLCALL';
    var opts = knownGroups(list).slice();
    if (openCall && opts.indexOf(openCall) < 0) opts.unshift(openCall);
    heard.forEach(function (h) { if (opts.indexOf(h.call) < 0) opts.push(h.call); });
    toEl.innerHTML = '';
    opts.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      toEl.appendChild(opt);
    });
    toEl.value = opts.indexOf(want) >= 0 ? want : opts[0];
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
    // Point the To box at whoever was opened, BEFORE renderConvs rebuilds the
    // list — it preserves the current selection, so setting it after would be
    // overwritten by the previous value.
    if (r && r.thread && r.thread.call) toEl.value = r.thread.call;
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
      d.textContent = running ? 'Nobody decoded yet.' : '';
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
        toEl.value = h.call;
        textEl.value = '';
        textEl.focus();
        refreshCompose();
      });
      heardEl.appendChild(b);
    });
  }

  // ── compose ────────────────────────────────────────────────────────────────

  function renderChips() {
    chipsEl.innerHTML = '';
    CHIPS.forEach(function (label) {
      var b = document.createElement('button');
      b.className = 'jc-chip';
      b.type = 'button';
      b.textContent = label;
      b.disabled = !running;
      b.title = 'Put "' + label + '" in the message box';
      b.addEventListener('click', function () {
        // Body only — the To box already carries the destination, and a second
        // one in the text would be transmitted verbatim.
        textEl.value = label;
        textEl.focus();
        refreshCompose();
      });
      chipsEl.appendChild(b);
    });
  }

  /**
   * Preview of what will go on the air.
   *
   * Mirrors composeDirected() in lib/js8call-threads.js, which is the tested
   * original and the one that actually addresses the transmission — main
   * composes from {text, to} so this can never disagree with what is sent.
   * Duplicated here only because the renderer has no require() (same reason
   * gridToLatLonLocal exists in app.js).
   */
  var GROUPS = ['@HB', '@ALLCALL', '@DX', '@GROUP', '@QSO', '@NET', '@CQ'];
  function isAddressed(t) {
    return /^@[A-Z0-9/]{2,}(s|$)/i.test(t) || /^[A-Z0-9/]{2,}:/i.test(t);
  }
  function outgoing() {
    var body = textEl.value.trim();
    if (!body) return '';
    if (isAddressed(body)) return body;
    var to = (toEl.value || '').trim().toUpperCase();
    if (!to) return body;
    var group = to.charAt(0) === '@' || GROUPS.indexOf(to) >= 0;
    return group ? to + ' ' + body : to + ': ' + body;
  }
  function refreshCompose() {
    textEl.disabled = toEl.disabled = !running;
    sendBtn.disabled = !running || !textEl.value.trim();
    textEl.placeholder = running ? 'Message' : 'JS8 is off';
    renderChips();
    var t = outgoing();
    if (t && !onairEl.classList.contains('err') && !onairEl.classList.contains('ok')) {
      // Show exactly what leaves. A transmit control that hides its payload is
      // how the wrong thing ends up on the air.
      onairEl.className = '';
      onairEl.innerHTML = 'Goes on the air as <code>' + esc(t) + '</code>';
    } else if (!t && !onairEl.classList.contains('err') && !onairEl.classList.contains('ok')) {
      onairEl.innerHTML = '';
    }
  }

  function note(html, cls) { onairEl.className = cls || ''; onairEl.innerHTML = html; }

  async function transmit(text, to) {
    note('Queueing…', '');
    var r;
    try { r = await window.api.send(text, to); }
    catch (e) { note('Send failed: ' + esc(e && e.message), 'err'); return; }
    if (r && r.ok) {
      note('On the air over the next ' + (r.frames > 1 ? r.frames + ' periods' : 'period') +
        ': <code>' + esc(r.text) + '</code>', 'ok');
      textEl.value = '';
    } else {
      note(esc((r && r.error) || 'Send refused.'), 'err');
    }
    refreshCompose();
  }

  sendBtn.addEventListener('click', function () {
    var body = textEl.value.trim();
    if (body) transmit(body, toEl.value);
  });
  toEl.addEventListener('change', refreshCompose);
  textEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); sendBtn.click(); }
  });
  textEl.addEventListener('input', function () {
    onairEl.className = '';
    refreshCompose();
  });

  // ── station actions ────────────────────────────────────────────────────────
  // These SEND (CQ) or schedule sending (HB) — station acts, not compose acts.

  cqBtn.addEventListener('click', function () {
    transmit('CQ CQ CQ', '');
  });

  hbBtn.addEventListener('click', async function () {
    try {
      var r = await window.api.heartbeat({ enabled: !hbOn, intervalMin: hbMinEl.value });
      hbOn = !!(r && r.enabled);
      renderHb();
    } catch (e) { /* status push will correct us */ }
  });

  function renderHb() {
    hbBtn.className = 'jc-btn' + (hbOn ? ' hb-on' : '');
    hbBtn.textContent = 'HB';
    hbBtn.title = hbOn
      ? 'Heartbeat is on — turns itself off after 30 minutes without you'
      : 'Heartbeat every few minutes while you are at the radio';
  }

  // ── start / stop ───────────────────────────────────────────────────────────

  async function startJs8() {
    setupErr.textContent = '';
    setupStart.disabled = powerBtn.disabled = true;
    var r;
    try { r = await window.api.start(); }
    catch (e) { r = { ok: false, error: String(e && e.message) }; }
    setupStart.disabled = powerBtn.disabled = false;
    if (!(r && r.ok)) {
      setupErr.textContent = (r && r.error) || 'JS8 did not start.';
      return;
    }
    var min = parseInt(hbMinEl.value, 10);
    if (min) { try { await window.api.heartbeat({ intervalMin: min }); } catch (e) {} }
  }

  setupStart.addEventListener('click', startJs8);
  powerBtn.addEventListener('click', function () {
    if (running) window.api.stop();
    else startJs8();
  });

  function showRunning(on) {
    setupEl.hidden = on;
    colsEl.hidden = !on;
  }

  // ── wire-up ────────────────────────────────────────────────────────────────

  window.api.onStatus(function (s) {
    var up = !!(s && (s.running || s.connected));
    var was = running;
    running = up;
    dotEl.className = 'jc-dot ' + (up ? 'up' : 'down');
    stateEl.textContent = up ? 'JS8 running' : 'JS8 is off';

    var st = (s && s.station) || {};
    stationEl.textContent = st.call || '';
    submodeEl.textContent = up && s.submode ? s.submode : '';

    var tx = !!(s && s.tx);
    var queued = (s && s.txQueue) || 0;
    txEl.className = 'jc-tx' + (tx ? ' on' : '');
    txEl.textContent = tx ? 'TX' : (queued ? queued + ' queued' : 'RX');
    txEl.title = tx ? 'Transmitting this period.' : 'Receiving.';

    hbOn = !!(s && s.heartbeat);
    renderHb();

    actsEl.hidden = !up;
    powerBtn.textContent = up ? 'Stop' : 'Start';
    if (up !== was) showRunning(up);
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
  });

  window.api.onActivity(function () { /* the all-traffic pane is a follow-up */ });

  window.api.onTheme(function (t) {
    if (typeof window._applyPopoutTheme === 'function') window._applyPopoutTheme(t);
  });

  // Initial state.
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
    renderHb();
    showRunning(false);   // the status push corrects this if JS8 is already up
  })();
  // Relative times drift; re-render the rails once a minute so "4m" stays true.
  setInterval(function () { if (lastList.length) renderConvs(lastList); renderHeard(heard); }, 60000);

  window.addEventListener('beforeunload', function () { window.api.threadClosed(); });

  // Titlebar buttons.
  el('jc-min').addEventListener('click', function () { window.api.minimizeWindow(); });
  el('jc-max').addEventListener('click', function () { window.api.maximizeWindow(); });
  el('jc-close').addEventListener('click', function () { window.api.closeWindow(); });

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
