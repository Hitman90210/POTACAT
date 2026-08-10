// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// JS8 Heartbeat Map — "who can I reach?"
//
// RX-only reachability picture built from the heartbeat net: stations we
// decode (green), stations that report hearing US via an SNR reply (blue),
// and both (amber). Positions come from the grid carried in heartbeats;
// a station whose grid we've never heard has no marker (list-only on the
// heard rail — a marker in a guessed place is worse than none).
(function () {
  'use strict';

  document.getElementById('tb-min').addEventListener('click', function () { window.api.minimize(); });
  document.getElementById('tb-max').addEventListener('click', function () { window.api.maximize(); });
  document.getElementById('tb-close').addEventListener('click', function () { window.api.close(); });
  window.api.onTheme(function (t) {
    if (typeof window._applyPopoutTheme === 'function') window._applyPopoutTheme(t);
  });

  var map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([20, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 12, attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  function gridToLatLon(grid) {
    if (!grid || grid.length < 4) return null;
    var g = grid.toUpperCase();
    var lon = (g.charCodeAt(0) - 65) * 20 - 180 + (parseInt(g[2], 10) * 2) + 1;
    var lat = (g.charCodeAt(1) - 65) * 10 - 90 + parseInt(g[3], 10) + 0.5;
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return [lat, lon];
  }

  var layer = L.layerGroup().addTo(map);
  var homeMarker = null;
  var centered = false;

  function ago(utc) {
    var m = Math.round((Date.now() - utc) / 60000);
    return m < 1 ? 'now' : m < 60 ? m + 'm ago' : Math.round(m / 60) + 'h ago';
  }

  window.api.onData(function (d) {
    if (!d) return;
    layer.clearLayers();

    var home = d.home && gridToLatLon(d.home.grid);
    if (home) {
      if (!homeMarker) {
        homeMarker = L.circleMarker(home, { radius: 6, color: '#e94560', fillColor: '#e94560', fillOpacity: 1 })
          .bindPopup('<b>' + (d.home.call || 'Home') + '</b><br>' + d.home.grid).addTo(map);
      } else homeMarker.setLatLng(home);
      if (!centered) { centered = true; map.setView(home, 4); }
    }

    // Merge the two directions by call.
    var by = {};
    (d.heard || []).forEach(function (h) { by[h.call] = { heard: h }; });
    (d.heardBy || []).forEach(function (h) {
      (by[h.call] = by[h.call] || {}).heardBy = h;
    });

    var plotted = 0, total = 0;
    Object.keys(by).forEach(function (call) {
      total++;
      var e = by[call];
      var grid = (e.heard && e.heard.grid) || (e.heardBy && e.heardBy.grid) || '';
      var pos = gridToLatLon(grid);
      if (!pos) return;
      plotted++;
      var both = e.heard && e.heardBy;
      var color = both ? '#f0a500' : e.heard ? '#4ecca3' : '#4fc3f7';
      var lines = ['<b>' + call + '</b> &middot; ' + grid];
      if (e.heard) lines.push('I hear them: ' + (e.heard.snr > 0 ? '+' : '') + e.heard.snr + ' dB &middot; ' + ago(e.heard.utc));
      if (e.heardBy) lines.push('They hear me: ' + (e.heardBy.snr > 0 ? '+' : '') + e.heardBy.snr + ' dB &middot; ' + ago(e.heardBy.utc));
      // Plot at -360/0/+360 so markers survive scrolling past the antimeridian —
      // but draw the reach line ONLY to the copy nearest home, or the two far
      // wraps paint "around the earth" horizontals (K3SBP 2026-08-10).
      var bestOff = 0;
      if (home) {
        var bestD = Infinity;
        [-360, 0, 360].forEach(function (off) {
          var d = Math.abs((pos[1] + off) - home[1]);
          if (d < bestD) { bestD = d; bestOff = off; }
        });
      }
      [-360, 0, 360].forEach(function (off) {
        var m = L.circleMarker([pos[0], pos[1] + off], {
          radius: 6, color: color, fillColor: color, fillOpacity: 0.85, weight: both ? 2.5 : 1.5,
        }).bindPopup(lines.join('<br>'));
        layer.addLayer(m);
        if (home && off === bestOff) {
          layer.addLayer(L.polyline([home, [pos[0], pos[1] + off]], { color: color, weight: 1, opacity: 0.35 }));
        }
      });
    });

    var el = document.getElementById('jm-count');
    el.textContent = total === 0 ? 'Listening — no stations heard yet'
      : plotted + ' of ' + total + ' stations mapped' + (plotted < total ? ' (no grid for the rest)' : '');
  });

  window.api.ready();
})();
