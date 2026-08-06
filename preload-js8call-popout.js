// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Preload for the JS8Call message view. contextBridge only — no Node reaches
// the renderer. Mirrors preload-mercury-popout.js.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  // Window chrome (the popout is frameless off macOS).
  minimizeWindow: () => ipcRenderer.send('js8call-popout-minimize'),
  closeWindow: () => ipcRenderer.send('js8call-popout-close'),

  // Bridge state: { connected, tx, host, port, error, problems[], station{} }.
  onStatus: (cb) => ipcRenderer.on('js8call-status', (_e, s) => cb(s)),
  // One decoded line. `replay:true` marks the backfill sent on window open.
  onActivity: (cb) => ipcRenderer.on('js8call-activity', (_e, a) => cb(a)),
  // Every raw API message, for the diagnostics pane.
  onMessage: (cb) => ipcRenderer.on('js8call-message', (_e, m) => cb(m)),
  onTheme: (cb) => ipcRenderer.on('js8call-popout-theme', (_e, t) => cb(t)),

  reconnect: () => ipcRenderer.send('js8call-reconnect'),
  // Transmit. Returns {ok, error, text} so a refusal can be shown rather than
  // silently doing nothing.
  send: (text) => ipcRenderer.invoke('js8call-send', text),
  heartbeatText: () => ipcRenderer.invoke('js8call-heartbeat-text'),
  checkSetup: () => ipcRenderer.invoke('js8call-check-setup'),
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Per-window zoom, same convention as the other popouts.
  setZoom: (z) => webFrame.setZoomFactor(z),
  getZoom: () => webFrame.getZoomFactor(),
});
