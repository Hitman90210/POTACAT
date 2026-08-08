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
      convsEl = el('jc-convs'), groupsEl = el('jc-groups'), unreadEl = el('jc-unread'),
      headEl = el('jc-threadhead'), colsEl = el('jc-cols'), toEl = el('jc-to'),
      bandWrap = el('jc-band-wrap'), bandEl = el('jc-band'), actsEl = el('jc-acts'),
      msgsEl = el('jc-msgs'), chipsEl = el('jc-chips'),
      textEl = el('jc-text'), sendBtn = el('jc-send'), onairEl = el('jc-onair'),
      heardEl = el('jc-heard');

  var setupEl = el('jc-setup'), setupTitle = el('jc-setup-title'), setupLede = el('jc-setup-lede'),
      setupChanges = el('jc-setup-changes'), setupGo = el('jc-setup-go'),
      setupLaunch = el('jc-setup-launch'), setupRadioWrap = el('jc-setup-radio-wrap'),
      setupRadio = el('jc-setup-radio'), setupRadioWhy = el('jc-setup-radio-why'),
      audioBox = el('jc-audio'), audioLede = el('jc-audio-lede'), audioRx = el('jc-audio-rx'),
      audioTx = el('jc-audio-tx'), audioOn = el('jc-audio-on'), audioOff = el('jc-audio-off'),
      audioNote = el('jc-audio-note'),
      setupNote = el('jc-setup-note'), setupDax = el('jc-setup-dax'),
      setupSlice = el('jc-setup-slice'), setupSliceWhy = el('jc-setup-slice-why'),
      setupManual = el('jc-setup-manual');

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

  // ── groups ─────────────────────────────────────────────────────────────────
  // JS8's group calls are how you reach more than one station, and burying them
  // in the same alphabetical list as individuals makes the common case a scroll.
  // @ALLCALL and @HB always exist; anything else seen on air joins them.
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
    // Stored conversations are readable offline, so opening one takes the
    // window back from the setup page. The status chip puts it back.
    showSetup(false);
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
        // Address it with the To box, not a typed prefix — outgoing() would
        // otherwise see a hand-addressed message and send "CALL: CALL: text".
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
    // HB and CQ moved to the control bar: they are STATION actions and must not
    // be disabled just because no conversation is selected.
    var items = CHIPS.slice();
    items.forEach(function (label) {
      var b = document.createElement('button');
      b.className = 'jc-chip';
      b.type = 'button';
      b.textContent = label;
      b.disabled = !connected;
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
  var GROUPS = ["@HB", "@ALLCALL", "@DX", "@GROUP", "@QSO", "@NET", "@CQ"];
  function isAddressed(t) {
    return /^@[A-Z0-9/]{2,}(s|$)/i.test(t) || /^[A-Z0-9/]{2,}:/i.test(t);
  }
  function outgoing() {
    var body = textEl.value.trim();
    if (!body) return "";
    if (isAddressed(body)) return body;
    var to = (toEl.value || "").trim().toUpperCase();
    if (!to) return body;
    var group = to.charAt(0) === "@" || GROUPS.indexOf(to) >= 0;
    return group ? to + " " + body : to + ": " + body;
  }
  function refreshCompose() {
    textEl.disabled = toEl.disabled = !connected;
    sendBtn.disabled = !connected || !textEl.value.trim();
    textEl.placeholder = connected ? 'Message' : 'Not connected';
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
    note('Sending…', '');
    var r;
    try { r = await window.api.send(text, to); }
    catch (e) { note('Send failed: ' + esc(e && e.message), 'err'); return; }
    if (r && r.ok) { note('Queued <code>' + esc(r.text) + '</code>', 'ok'); textEl.value = ''; }
    else note(esc((r && r.error) || 'Send refused.'), 'err');
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

  // ── POTACAT as the sound card ──────────────────────────────────────────────
  // The route that needs no DAX, no SmartSDR and no slice of its own: POTACAT
  // plays the slice audio it already receives into a virtual cable, JS8Call
  // records from the other end, and JS8Call's transmit audio comes back the
  // same way onto the dax_tx stream JTCAT already uses.

  function fillDevices(sel, list, chosen) {
    sel.innerHTML = '';
    var none = document.createElement('option');
    none.value = ''; none.textContent = '(none)';
    sel.appendChild(none);
    (list || []).forEach(function (d) {
      var o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || d.deviceId.slice(0, 24);
      sel.appendChild(o);
    });
    sel.value = chosen || '';
  }

  async function refreshAudioBridge() {
    var p;
    try { p = await window.api.audioPlan(); } catch (e) { p = null; }
    if (!p) { audioBox.hidden = true; return null; }
    audioBox.hidden = false;

    var cables = (p.devices || []).filter(function (d) {
      return /vb-audio|cable|voicemeeter|virtual audio/i.test(d.label || '');
    });
    fillDevices(audioRx, cables.filter(function (d) { return d.kind === 'audiooutput'; }),
      p.rx && p.rx.deviceId);
    fillDevices(audioTx, cables.filter(function (d) { return d.kind === 'audioinput'; }),
      p.tx && p.tx.deviceId);

    audioOn.hidden = !!p.enabled;
    audioOff.hidden = !p.enabled;
    audioLede.innerHTML = p.enabled
      ? 'POTACAT is JS8Call’s sound card. It plays this radio’s receive audio into the cable ' +
        'below, so JS8Call needs no DAX, no SmartSDR and no receiver of its own.'
      : 'POTACAT already has this radio’s audio. It can play it straight into a virtual cable that ' +
        'JS8Call records from — no DAX program, no SmartSDR, no second slice. Transmit comes back ' +
        'the same way, onto the path JTCAT and SSTV already use here.';

    var notes = [];
    if (p.rxReason) notes.push(p.rxReason);
    if (p.txReason) notes.push(p.txReason);
    if (p.enabled && p.running) notes.push('Receive audio is flowing.');
    audioNote.innerHTML = notes.map(esc).join('<br>');
    // Returned because the setup flow above has to know whether this route is
    // live: with POTACAT as the sound card, DAX and SmartSDR CAT stop being
    // prerequisites at all, and gating the launch on them strands the operator
    // on a screen whose own instructions say to skip them (K3SBP 2026-08-08).
    return p;
  }

  async function saveAudioBridge(enabled) {
    try {
      await window.api.setAudioBridge({
        enabled: enabled,
        rxDeviceId: audioRx.value,
        txDeviceId: audioTx.value,
      });
    } catch (e) { audioNote.textContent = 'Could not save: ' + (e && e.message); return; }
    // The WHOLE setup screen, not just this panel. Switching the bridge on
    // removes DAX and SmartSDR CAT as prerequisites, which changes the heading,
    // the notes, and which buttons exist at all — refreshSetup redraws those and
    // calls refreshAudioBridge on its way through. Refreshing only this panel
    // left the operator reading "JS8Call needs two SmartSDR helpers running"
    // directly above a live "Receive audio is flowing", with every button that
    // starts JS8Call still hidden until they happened to press Retry
    // (K3SBP 2026-08-08).
    refreshSetup();
  }

  audioOn.addEventListener('click', function () { saveAudioBridge(true); });
  audioOff.addEventListener('click', function () { saveAudioBridge(false); });
  // Changing a device keeps the bridge in whatever state it is already in —
  // picking a different cable should not switch the sound card on, and should
  // not switch it off while it is carrying audio. audioOff is visible exactly
  // when the bridge is enabled.
  function onDeviceChange() { saveAudioBridge(!audioOff.hidden); }
  audioRx.addEventListener('change', onDeviceChange);
  audioTx.addEventListener('change', onDeviceChange);

  // ── station actions + band ─────────────────────────────────────────────────
  // These act on the STATION, not on a conversation, so they live in the bar
  // and stay live whenever the bridge is up.

  // These SEND. A button labelled HB that only fills a box is not a heartbeat,
  // and JS8Call's own HB button transmits — matching it avoids a control that
  // means something different in the two windows side by side.
  el('jc-cq').addEventListener('click', function () {
    transmit('CQ CQ CQ', '@ALLCALL');
  });

  el('jc-hb').addEventListener('click', function () {
    // hbText already carries its own "@HB " prefix from JS8Call's own template,
    // so it is passed as-is; composeDirected leaves addressed text alone.
    transmit(hbText || 'HB', '@HB');
  });

  /**
   * The band picker moves JS8Call's OWN receiver.
   *
   * Never the operator's slice: POTACAT created a second one for JS8Call, and
   * that is the only thing this touches. Hidden entirely when JS8Call has no
   * receiver of its own, because then there is nothing POTACAT may retune.
   */
  async function refreshBands() {
    var st;
    try { st = await window.api.bandState(); } catch (e) { st = null; }
    if (!st || !st.hasSlice || !st.bands || !st.bands.length) {
      bandWrap.hidden = true;
      return;
    }
    bandWrap.hidden = false;
    var want = st.current || Number(bandEl.value) || 20;
    bandEl.innerHTML = '';
    st.bands.forEach(function (b) {
      var o = document.createElement('option');
      o.value = String(b);
      o.textContent = b + 'm';
      bandEl.appendChild(o);
    });
    bandEl.value = String(want);
  }

  bandEl.addEventListener('change', async function () {
    var band = Number(bandEl.value);
    bandEl.disabled = true;
    var r;
    try { r = await window.api.setBand(band); } catch (e) { r = { ok: false, reason: e && e.message }; }
    bandEl.disabled = false;
    if (!r || !r.ok) { note(esc((r && r.reason) || 'Could not change band.'), 'err'); refreshBands(); return; }
    note('JS8Call’s receiver moved to <code>' + r.freq.toFixed(3) + ' MHz</code> (' + r.band + 'm)', 'ok');
  });

  // Reading an old conversation shouldn't strand you away from setup.
  stateEl.addEventListener('click', function () { if (!connected) refreshSetup(); });

  el('jc-min').addEventListener('click', function () { window.api.minimizeWindow(); });
  el('jc-max').addEventListener('click', function () { window.api.maximizeWindow(); });
  el('jc-close').addEventListener('click', function () { window.api.closeWindow(); });
  el('jc-retry').addEventListener('click', function () { window.api.reconnect(); });
  el('jc-refresh').addEventListener('click', function () { window.api.refreshHeard(); });

  // ── setup ──────────────────────────────────────────────────────────────────
  // Doing this by hand is six steps across three JS8Call settings pages. POTACAT
  // offers to do it instead — but always lists exactly what it will change
  // first, because this edits another application's config file.

  // Kept, but FOLDED. Someone who would rather not have POTACAT touch their
  // config — or whose JS8Call is open — still needs the steps; everyone else
  // needs one button. A wall of manual procedure printed beside that button
  // makes the reader work out which of the two they are being offered.
  var MANUAL = '<b>In JS8Call:</b><br>' +
    '1. <code>File &gt; Settings &gt; Reporting &gt; API</code> — tick <code>Enable TCP Server API</code> ' +
    'and <code>Accept TCP Requests</code>, and set max connections to 2 or more.<br>' +
    '2. Restart JS8Call.';

  // "I tried opening JS8Call-Improved and it gave me grief for not having my
  // radio connected" (K3SBP 2026-08-06). That complaint is about the RADIO, not
  // the API, and the honest answer depends on what the radio can do — so say
  // which one applies rather than one paragraph that is half wrong either way.
  function radioAdvice(canDoRadio) {
    if (canDoRadio) {
      return '<b>The radio:</b> JS8Call complains it has no radio until it has its own slice. ' +
        'POTACAT gives it one — both apps then receive at once, on different bands if you ' +
        'like, and POTACAT keeps the transmitter.';
    }
    return '<b>The radio:</b> JS8Call will complain it has no radio, because POTACAT holds ' +
      'the one CAT connection your rig has. That is expected, and JS8Call still decodes fine ' +
      'without it. Set <code>File &gt; Settings &gt; Radio &gt; Rig</code> to <code>None</code> ' +
      'to stop it asking; tune and transmit from POTACAT.';
  }

  /** The fold. Collapsed by default — open it only if the button is not what
   *  you want. `open` forces it out for the states where it IS the answer. */
  function foldout(html, open) {
    return '<details class="jc-fold-out"' + (open ? ' open' : '') + '>' +
      '<summary>Rather do it yourself?</summary><div>' + html + '</div></details>';
  }

  // The setup panel and the transcript share one slot in the column — exactly
  // one of them is up at a time, so the window always answers the question the
  // operator actually has right now ("why is nothing here" vs "what was said").
  function showSetup(on) {
    // Setup owns the WHOLE window, rails included. Without a connection the
    // conversation list and the heard rail have nothing to show, and squeezing
    // a page of setup into the middle third of a three-column grid is what
    // produced two nested scrollbars in a 250 px column.
    setupEl.hidden = !on;
    colsEl.hidden = on;
    headEl.hidden = on || !openCall;
    // The diagnostics bar goes too. Every problem it lists is either something
    // the button below fixes or something POTACAT deliberately leaves alone —
    // printing all of it beside a one-click offer makes the operator read six
    // manual procedures to decide whether to press one button. It returns once
    // connected, where a notice ("JS8Call may transmit on its own") is the only
    // thing being said and is worth saying.
    problemsEl.hidden = on;
  }

  var setupBusy = false, setupAgain = false;
  // Once the operator moves the slice checkbox it is theirs, not ours.
  var radioTouched = false;

  async function refreshSetup() {
    if (connected) { showSetup(false); return; }
    // Coalesce rather than drop. A refresh asked for while one is in flight is
    // the one that matters — the operator just changed something — and throwing
    // it away leaves the screen describing the state before their click.
    if (setupBusy) { setupAgain = true; return; }
    setupBusy = true;
    try {
      do { setupAgain = false; await refreshSetupInner(); } while (setupAgain);
    } finally { setupBusy = false; }
  }

  async function refreshSetupInner() {
    showSetup(true);
    // Awaited, not fired and forgotten: every branch below depends on whether
    // POTACAT is already acting as JS8Call's sound card.
    var audio = await refreshAudioBridge();
    var bridgeOn = !!(audio && audio.enabled);
    setupChanges.innerHTML = '';
    setupNote.hidden = true;
    setupGo.hidden = setupLaunch.hidden = setupRadioWrap.hidden = true;
    setupDax.hidden = setupSlice.hidden = setupSliceWhy.hidden = true;

    var p;
    // includeRadio deliberately unsent on the first pass: main decides it from
    // the collisions it actually found, and the checkbox reflects that answer
    // rather than asking the operator to diagnose their own station.
    var opts = radioTouched ? { includeRadio: !!(setupRadio && setupRadio.checked) } : {};
    try { p = await window.api.planSetup(opts); }
    catch (e) { setupLede.textContent = 'Could not check JS8Call: ' + (e && e.message); return; }

    if (!p || !p.ok) {
      setupTitle.textContent = 'JS8Call is not installed';
      setupLede.innerHTML = 'Download it from <span class="jc-link" data-ext="http://js8call.com/">js8call.com</span> ' +
        'and run it once, then reopen this window — POTACAT will do the rest of the setup for you.';
      setupManual.innerHTML = '';
      wireExternal();
      return;
    }

    // DAX down comes FIRST and alone. Every other state on this screen offers to
    // change JS8Call's settings, and no setting reaches the radio while the DAX
    // endpoints are inert placeholders — showing the usual button here would
    // hand the operator a fix that cannot work.
    // ...unless POTACAT is the sound card, in which case neither helper is a
    // prerequisite for anything: the audio comes over the network and the
    // radio is tuned from here. Blocking on them anyway put the operator on a
    // screen headed "JS8Call needs two SmartSDR helpers running" directly above
    // a panel headed "Skip DAX entirely", with no way to start JS8Call at all.
    if ((p.daxDown || p.catShimDown) && !bridgeOn) {
      // Both prerequisites at once. POTACAT reaches a Flex over the native API
      // and needs neither of these, so on a Flex Direct station they are BOTH
      // usually missing — reporting one per visit turns a single answer into a
      // guessing game across several rounds.
      setupTitle.textContent = 'JS8Call needs two SmartSDR helpers running';
      setupLede.innerHTML =
        'POTACAT drives your Flex over the network, so it needs neither of these and they are not running. ' +
        'JS8Call is an ordinary Windows program: it can only hear the radio through DAX’s sound devices, ' +
        'and only tune it through a SmartSDR CAT serial port.';
      setupChanges.innerHTML = '';
      if (p.daxDown) {
        var li1 = document.createElement('li');
        li1.innerHTML = '<b>DAX</b> — audio. Without it the sound devices exist but carry nothing, ' +
          'which JS8Call reports as “Requested output audio format is not supported on device”.';
        setupChanges.appendChild(li1);
      }
      if (p.catShimDown) {
        var li2 = document.createElement('li');
        li2.innerHTML = '<b>SmartSDR CAT</b> — radio control. Nothing is listening on ports 5002-5005, ' +
          'so JS8Call has no port to point at and reports no radio.';
        setupChanges.appendChild(li2);
      }
      // ONE button, and it starts SmartSDR — not the helpers. SmartSDR brings
      // DAX and CAT up with it, and starting CAT alone makes POTACAT believe
      // SmartSDR launched (it infers that from port 5002 answering), drop its
      // GUI slot, and sit through the yield timeout for nothing.
      setupDax.hidden = !p.smartSdrApp;
      setupManual.innerHTML =
        (p.yieldsGuiSlot
          ? '<p class="jc-quiet">Note: multiFlex is off, so POTACAT will hand the radio’s GUI slot to ' +
            'SmartSDR and follow it. Rig control keeps working; SmartSDR becomes the one in charge.</p>'
          : '') +
        foldout('<b>Once SmartSDR is up:</b> in DAX tick a <code>DAX RX</code> channel and <code>DAX TX</code>; ' +
          'in SmartSDR CAT create a port for a slice. Then press Retry above and POTACAT will finish the setup.' +
          '<br><br><b>Or skip all of it.</b> Set JS8Call’s <code>Radio &gt; Rig</code> to <code>None</code> and give ' +
          'it audio from a virtual cable — it decodes without touching the radio, and you tune from POTACAT.');
      return;
    }

    // A Flex with a spare receiver can simply give JS8Call one, which removes
    // the whole "which DAX channel has a slice behind it" problem rather than
    // navigating it. Offered before the audio changes, because the answer to
    // "which channel" depends on it.
    if (p.slicePlan && p.slicePlan.ok) {
      setupSlice.hidden = false;
      setupSlice.textContent = 'Give JS8Call its own receiver';
      setupSliceWhy.hidden = false;
      setupSliceWhy.innerHTML = 'Creates a second slice on ' +
        esc(p.slicePlan.freq.toFixed(3)) + ' MHz ' + esc(p.slicePlan.mode) +
        ' and binds it to DAX channel ' + p.slicePlan.daxChannel +
        '. JS8Call then has a receiver of its own and you keep slice A. ' +
        'POTACAT removes it again when it closes.';
    } else if (p.slicePlan && p.slicePlan.reason) {
      setupSlice.hidden = true;
      setupSliceWhy.hidden = false;
      setupSliceWhy.textContent = 'No separate receiver for JS8Call: ' + p.slicePlan.reason;
    } else if (p.js8Slice !== null && p.js8Slice !== undefined) {
      setupSlice.hidden = true;
      setupSliceWhy.hidden = false;
      setupSliceWhy.textContent = 'JS8Call has its own receiver (slice ' + p.js8Slice + ').';
    } else {
      setupSlice.hidden = setupSliceWhy.hidden = true;
    }

    // Never offered on the bridge route: this box writes DAX device names into
    // JS8Call.ini, which is precisely the wiring the bridge replaces.
    setupRadioWrap.hidden = !p.canDoRadio || bridgeOn;
    if (setupRadio && !radioTouched) setupRadio.checked = !!p.includeRadio;
    // The label carries whatever the change list above does NOT. Ticked, the
    // list already spells the move out, so this is just the toggle's name.
    // Unticked there is no line, so the box has to state the reason itself —
    // otherwise a detected collision would sit on screen unmentioned.
    if (setupRadioWhy) {
      // ONE meaning, always. This used to read "give it its own slice" while
      // the button above said "Give JS8Call its own receiver" — two controls,
      // nearly the same words, completely different jobs (this writes device
      // names into JS8Call.ini; the button creates a slice on the radio).
      setupRadioWhy.textContent = 'also set which audio devices JS8Call uses';
    }

    // A device JS8Call is told to open that is not on this PC is the single
    // most misleading failure in the chain: JS8Call reports it as "Requested
    // output audio format is not supported on device", which sends the
    // operator hunting through sample rates for a device that is not there.
    // Name the string.
    // Reported on BOTH routes. Suppressing these on the bridge route was wrong:
    // JS8Call opens its input AND output devices at startup regardless of which
    // one POTACAT cares about, so a stale DAX device still stops it dead with
    // "Requested output audio format is not supported on device" — before any
    // question of transmitting arises. What changes with the route is the
    // REMEDY, not whether the operator needs to know (K3SBP 2026-08-08).
    var dead = (p.deviceProblems || []).filter(Boolean);
    // The radio-side twin of a dead audio device, and the only remaining reason
    // JS8Call still says it has no rig once the audio is right. On the bridge
    // route the Rig=None advice lives in the bridge note instead, so this would
    // be the same instruction twice.
    if (p.catPortDead && !bridgeOn) {
      dead = dead.concat([
        'Radio control is set to port ' + p.catPortWanted + ', and nothing is listening there' +
        (p.catPortsLive && p.catPortsLive.length
          ? ' (SmartSDR CAT is only serving ' + p.catPortsLive.join(', ') + ', which POTACAT is using)'
          : '') + '.',
      ]);
    }
    setupNote.hidden = !dead.length;
    if (dead.length) {
      setupNote.innerHTML =
        '<b>JS8Call’s audio devices will not work:</b>' +
        '<ul style="margin:6px 0 0;padding-left:18px;">' +
        dead.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') +
        '</ul><div style="margin-top:6px;">' +
        'A device that enumerates but carries nothing is still reported as “Requested output ' +
        'audio format is not supported on device”, which is why it reads like a format problem.' +
        (p.catPortDead
          ? '<br><br><b>The radio part, which POTACAT cannot do for you.</b> In JS8Call, ' +
            '<code>File &gt; Settings &gt; Radio</code>, set <b>both</b>:<br>' +
            '&nbsp;&nbsp;• <code>Rig</code> → <code>None</code><br>' +
            '&nbsp;&nbsp;• <code>PTT Method</code> → <code>VOX</code> ' +
            '<span style="opacity:.75">(it is set to CAT, which needs the rig you just removed — ' +
            'leaving it errors again)</span><br>' +
            'JS8Call then decodes without touching the radio, and you tune from POTACAT. ' +
            'These two live in Qt binary blobs that POTACAT cannot rewrite safely, which is why ' +
            'they are yours to click rather than a button here. ' +
            'The other option is a CAT port for a second slice in the SmartSDR CAT window.'
          : '') +
        '</div>';
    }

    // The instructions POTACAT genuinely cannot carry out. These live in the
    // same Qt binary blobs as Rig and PTT Method, and the capture device is not
    // derivable anyway: which B-bus carries a VoiceMeeter strip is a routing
    // choice made in its mixer, not a property of the device name.
    if (bridgeOn) {
      var rxLabel = (audio.rx && audio.rx.label) || '';
      var capture = /voicemeeter/i.test(rxLabel)
        ? 'the <code>Voicemeeter Out B</code> bus you switched on for that strip'
        : (/cable input/i.test(rxLabel)
          ? '<code>' + esc(rxLabel.replace(/input/i, 'Output')) + '</code>'
          : 'the capture half of that same cable');
      // The transmit pair runs the other way: POTACAT RECORDS from audio.tx, so
      // JS8Call has to PLAY into that cable's other half. Derivable for a
      // VB-CABLE, not for VoiceMeeter (a bus is fed by whichever strip the
      // operator routed to it), so say which without inventing a device name.
      var txLabel = (audio.tx && audio.tx.label) || '';
      var txPlayHtml = /cable output/i.test(txLabel)
        ? '<code>' + esc(txLabel.replace(/output/i, 'Input')) + '</code>'
        : (/voicemeeter/i.test(txLabel)
          ? 'the Voicemeeter strip you routed to that bus'
          : 'the play half of that cable');
      setupNote.hidden = false;
      // The dead devices come FIRST and are the reason the list below matters.
      // This note replaces the general one above, so it has to carry them or
      // they vanish — and "Requested output audio format is not supported on
      // device" is the error the operator is actually staring at.
      setupNote.innerHTML =
        (dead.length
          ? '<b>JS8Call is still pointed at devices that are not there:</b>' +
            '<ul style="margin:6px 0 0;padding-left:18px;">' +
            dead.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') +
            '</ul><div style="margin:6px 0 10px;">This is what JS8Call reports as ' +
            '“Requested output audio format is not supported on device”. It opens BOTH its ' +
            'devices at startup, so a stale one stops it before transmitting ever comes up.</div>'
          : '') +
        '<b>Set these in JS8Call itself:</b>' +
        '<ul style="margin:6px 0 0;padding-left:18px;">' +
        '<li><code>Settings &gt; Audio</code> → <b>Soundcard Input</b> → ' + capture +
        (rxLabel ? ' <span style="opacity:.75">(POTACAT plays into ' + esc(rxLabel) + ')</span>' : '') +
        '</li>' +
        // Output matters even though POTACAT does not use it yet: JS8Call opens
        // it at startup and refuses to run its audio if it is dead. With no
        // transmit cable there is no right answer, only a LIVE one — and saying
        // "anything that exists" is honest, where leaving it out is what left
        // the operator staring at a sound-output error on a working receiver.
        '<li><code>Settings &gt; Audio</code> → <b>Soundcard Output</b> → ' +
        (txLabel
          ? txPlayHtml
          : 'any device that exists — your speakers will do. ' +
            '<span style="opacity:.75">JS8Call will not start its audio with a dead one here, but ' +
            'nothing is transmitted until you set “Transmit from” above, and POTACAT refuses to ' +
            'key without it.</span>') +
        '</li>' +
        '<li><code>Settings &gt; Radio</code> → <b>Rig</b> → <code>None</code></li>' +
        '<li><code>Settings &gt; Radio</code> → <b>PTT Method</b> → <code>VOX</code> ' +
        '<span style="opacity:.75">(CAT would need the rig you just removed)</span></li>' +
        '</ul><div style="margin-top:6px;">' +
        'JS8Call then decodes without touching the radio: POTACAT feeds it audio, tunes the ' +
        'radio, and keys on the transmit signal JS8Call reports over its API.</div>';
    }

    if (p.running) {
      // Qt rewrites the whole ini on exit, so patching under a live instance
      // would be silently undone. Say that rather than failing later.
      setupTitle.textContent = 'Close JS8Call and POTACAT will set it up';
      setupLede.textContent = 'JS8Call rewrites its settings file when it exits, so anything changed while it is open would be undone. Close it and this will offer to do the whole thing in one click.';
      // Here the manual route IS the answer for someone who wants to stay in
      // JS8Call, so it opens rather than hiding behind a summary.
      setupManual.innerHTML = foldout(MANUAL + '<br><br>' + radioAdvice(p.canDoRadio), true);
      return;
    }

    if (!p.changes.length) {
      setupTitle.textContent = 'JS8Call is ready';
      setupLede.textContent = p.binary
        ? 'Its settings already suit POTACAT. Start it and traffic appears here.'
        : 'Its settings already suit POTACAT. Open JS8Call and traffic appears here.';
      setupLaunch.hidden = !p.binary;
      setupManual.innerHTML = (p.binary ? '' :
        '<p>POTACAT could not find the JS8Call program to start it. Set its location in ' +
        'Settings &gt; Station &gt; JS8Call if you want the button here.</p>') +
        foldout(radioAdvice(p.canDoRadio));
      return;
    }

    setupTitle.textContent = 'Set JS8Call up';
    setupLede.textContent = p.binary
      ? 'POTACAT will make these changes in JS8Call, then start it:'
      : 'POTACAT will make these changes in JS8Call. It could not find the program to start it, so open JS8Call yourself afterwards.';
    p.changes.forEach(function (c) {
      var li = document.createElement('li');
      li.textContent = c.label;
      setupChanges.appendChild(li);
    });
    setupGo.hidden = false;
    setupGo.textContent = p.binary ? 'Set up and start JS8Call' : 'Set up JS8Call';
    setupManual.innerHTML =
      '<p class="jc-quiet">Your JS8Call.ini is backed up first, and nothing else in it is touched.</p>' +
      foldout(MANUAL + '<br><br>' + radioAdvice(p.canDoRadio));
  }

  function wireExternal() {
    Array.prototype.forEach.call(setupManual.querySelectorAll('[data-ext]'), function (a) {
      a.addEventListener('click', function () { window.api.openExternal(a.dataset.ext); });
    });
  }

  setupGo.addEventListener('click', async function () {
    setupGo.disabled = true;
    setupGo.textContent = 'Setting up…';
    var r;
    try { r = await window.api.applySetup({ includeRadio: !!setupRadio.checked }); }
    catch (e) { r = { ok: false, error: e && e.message }; }
    setupGo.disabled = false;
    if (!r || !r.ok) {
      setupTitle.textContent = 'Could not set JS8Call up';
      setupLede.textContent = (r && r.error) || 'Unknown error.';
      setupChanges.innerHTML = '';
      setupGo.hidden = true;
      setupManual.innerHTML = MANUAL + '<br><br>' + radioAdvice(p.canDoRadio);
      return;
    }
    // Report what actually happened, not what was intended. The settings can
    // land and the launch still not run, and a panel that says "Starting
    // JS8Call" either way leaves the operator waiting on nothing.
    setupChanges.innerHTML = '';
    setupNote.hidden = true;
    setupGo.hidden = true;
    if (r.launchError) {
      setupTitle.textContent = 'Settings applied — now open JS8Call';
      setupLede.textContent = r.launchError;
      setupLaunch.hidden = true;
    } else if (r.already) {
      setupTitle.textContent = 'Settings applied';
      setupLede.textContent = 'JS8Call is already running. Restart it for the new settings to take effect — it only reads them at startup.';
    } else {
      setupTitle.textContent = 'Starting JS8Call…';
      setupLede.textContent = 'Settings applied. JS8Call takes a few seconds to open its audio device before POTACAT can connect.';
    }
  });

  setupLaunch.addEventListener('click', async function () {
    setupLaunch.disabled = true;
    var r;
    try { r = await window.api.launch(); } catch (e) { r = { ok: false, error: e && e.message }; }
    setupLaunch.disabled = false;
    if (!r || !r.ok) setupLede.textContent = (r && r.error) || 'Could not start JS8Call.';
    else { setupTitle.textContent = 'Starting JS8Call…'; setupLede.textContent = 'Give it a few seconds.'; setupLaunch.hidden = true; }
  });

  function wireHelperLaunch(btn, call, name, thenDo) {
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      var r;
      try { r = await call(); } catch (e) { r = { ok: false, error: e && e.message }; }
      btn.disabled = false;
      if (!r || !r.ok) { setupLede.textContent = (r && r.error) || ('Could not start ' + name + '.'); return; }
      btn.hidden = true;
      setupLede.textContent = 'Started ' + name + '. ' + thenDo + ' Then press Retry above.';
    });
  }
  setupSlice.addEventListener('click', async function () {
    setupSlice.disabled = true;
    setupSlice.textContent = 'Creating…';
    var r;
    try { r = await window.api.createSlice(); } catch (e) { r = { ok: false, reason: e && e.message }; }
    setupSlice.disabled = false;
    if (!r || !r.ok) {
      setupSliceWhy.textContent = (r && r.reason) || 'Could not create a receiver.';
      setupSlice.hidden = true;
      return;
    }
    // Re-plan: the audio devices to write depend on the channel it just took.
    radioTouched = false;
    refreshBands();          // JS8Call now has a receiver POTACAT may retune
    refreshSetup();
  });

  wireHelperLaunch(setupDax, function () { return window.api.launchSmartSdr(); }, 'SmartSDR',
    'It brings DAX and SmartSDR CAT up with it — tick a DAX RX channel and DAX TX, and make a CAT port for a slice.');

  if (setupRadio) setupRadio.addEventListener('change', function () {
    radioTouched = true;
    refreshSetup();
  });

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
    stateEl.style.cursor = up ? '' : 'pointer';
    stateEl.title = up ? '' : 'Show setup';

    var st = (s && s.station) || {};
    stationEl.textContent = st.call || '';
    dialEl.textContent = st.dial ? (Number(st.dial) / 1e6).toFixed(3) + ' MHz' : '';

    var tx = !!(s && s.tx);
    txEl.className = 'jc-tx' + (tx ? ' on' : '');
    txEl.textContent = tx ? 'JS8Call TX' : 'RX';
    txEl.title = tx
      ? 'JS8Call is transmitting. POTACAT has stood down and will not key until it finishes.'
      : 'JS8Call is receiving.';

    actsEl.hidden = !up;
    renderProblems(s && s.problems);
    if (up && !was) { loadHeartbeat(); refreshBands(); }
    if (!up) bandWrap.hidden = true;
    // The setup panel is the whole middle column until the bridge is live.
    if (up !== was || !up) refreshSetup();
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
    // Don't wait on a status push to answer "why is nothing here" — that is the
    // first question this window exists to answer.
    refreshSetup();
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
