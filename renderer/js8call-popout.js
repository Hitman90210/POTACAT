// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// JS8Call message view. Read-only in this phase: POTACAT watches a JS8Call the
// operator runs and shows what it hears, splitting general traffic from
// messages addressed to them. Sending is a later phase, gated on JS8Call's
// "Accept TCP Requests" and on POTACAT owning the PTT path.
(function () {
  'use strict';

  var MAX_ROWS = 500;          // matches the tail main keeps, with headroom

  var dotEl = document.getElementById('jc-dot');
  var stateEl = document.getElementById('jc-state');
  var stationEl = document.getElementById('jc-station');
  var txEl = document.getElementById('jc-tx');
  var problemsEl = document.getElementById('jc-problems');
  var emptyEl = document.getElementById('jc-empty');
  var paneAll = document.getElementById('jc-pane-all');
  var paneMine = document.getElementById('jc-pane-mine');

  document.getElementById('jc-min').addEventListener('click', function () { window.api.minimizeWindow(); });
  document.getElementById('jc-close').addEventListener('click', function () { window.api.closeWindow(); });
  document.getElementById('jc-retry').addEventListener('click', function () { window.api.reconnect(); });

  // Tabs
  Array.prototype.forEach.call(document.querySelectorAll('.jc-tab'), function (tab) {
    tab.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.jc-tab'), function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var want = tab.dataset.pane;
      paneAll.classList.toggle('active', want === 'all');
      paneMine.classList.toggle('active', want === 'mine');
    });
  });

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function hhmm(utc) {
    var n = Number(utc) || Date.now();
    // JS8Call sends epoch seconds on some builds and milliseconds on others.
    var d = new Date(n < 1e12 ? n * 1000 : n);
    return d.toISOString().slice(11, 16);
  }

  function trim(pane) {
    while (pane.childElementCount > MAX_ROWS) pane.removeChild(pane.firstChild);
  }

  function addRow(a) {
    if (emptyEl && emptyEl.parentNode) emptyEl.parentNode.removeChild(emptyEl);

    var row = document.createElement('div');
    row.className = 'jc-row' + (a.kind === 'to-me' ? ' to-me' : '') + (a.replay ? ' replay' : '');
    var snr = (a.snr === undefined || a.snr === null || a.snr === '') ? '' : (a.snr > 0 ? '+' + a.snr : String(a.snr));
    row.innerHTML =
      '<span class="jc-t">' + esc(hhmm(a.utc)) + '</span>' +
      '<span class="jc-s">' + esc(snr) + '</span>' +
      '<span class="jc-m">' + esc(a.text || '') + '</span>';

    // A row addressed to us goes in BOTH panes — "For me" is a filter, not a
    // separate stream, so switching tabs never loses context.
    var atBottom = paneAll.scrollTop + paneAll.clientHeight >= paneAll.scrollHeight - 30;
    paneAll.appendChild(row);
    trim(paneAll);
    if (atBottom) paneAll.scrollTop = paneAll.scrollHeight;

    if (a.kind === 'to-me') {
      var mine = row.cloneNode(true);
      var mineBottom = paneMine.scrollTop + paneMine.clientHeight >= paneMine.scrollHeight - 30;
      paneMine.appendChild(mine);
      trim(paneMine);
      if (mineBottom) paneMine.scrollTop = paneMine.scrollHeight;
    }
  }

  function renderProblems(list) {
    problemsEl.innerHTML = '';
    if (!list || !list.length) return;
    list.forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'jc-prob ' + (p.severity || 'warn');
      d.innerHTML = '<b>' + esc(p.message) + '</b><span>' + esc(p.fix || '') + '</span>';
      problemsEl.appendChild(d);
    });
  }

  window.api.onStatus(function (s) {
    var up = !!(s && s.connected);
    dotEl.className = 'jc-dot ' + (up ? 'up' : 'down');
    if (up) {
      stateEl.textContent = 'Connected' + (s.port ? ' · ' + s.host + ':' + s.port : '');
    } else {
      stateEl.textContent = (s && s.error) ? s.error : 'Not connected';
    }
    var st = (s && s.station) || {};
    var bits = [];
    if (st.call) bits.push(st.call);
    if (st.dial) bits.push((Number(st.dial) / 1e6).toFixed(3) + ' MHz');
    stationEl.textContent = bits.join(' · ');

    var tx = !!(s && s.tx);
    txEl.className = 'jc-tx' + (tx ? ' on' : '');
    txEl.textContent = tx ? 'JS8Call TX' : 'RX';
    txEl.title = tx
      ? 'JS8Call is transmitting. POTACAT has stood down and will not key until it finishes.'
      : 'JS8Call is receiving.';

    renderProblems(s && s.problems);
  });

  window.api.onActivity(addRow);

  window.api.onTheme(function (t) {
    if (typeof window._applyPopoutTheme === 'function') window._applyPopoutTheme(t);
  });

  // Zoom, matching every other popout (Ctrl +/-/0 and Ctrl+wheel), persisted
  // per window.
  var ZOOM_KEY = 'potacat-js8call-popout-zoom';
  var ZMIN = 0.7, ZMAX = 2.0, ZSTEP = 0.1;
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
