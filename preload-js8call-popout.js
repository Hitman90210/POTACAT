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

  // Conversations. State is owned by main (lib/js8call-threads.js) so unread
  // counts survive this window closing — an inbox that forgets is a log.
  threads: () => ipcRenderer.invoke('js8call-threads'),
  thread: (id) => ipcRenderer.invoke('js8call-thread', id),
  threadClosed: () => ipcRenderer.send('js8call-thread-closed'),
  onThreads: (cb) => ipcRenderer.on('js8call-threads', (_e, d) => cb(d)),

  // Who is audible right now.
  onHeard: (cb) => ipcRenderer.on('js8call-heard', (_e, list) => cb(list)),
  refreshHeard: () => ipcRenderer.send('js8call-refresh-heard'),
  checkSetup: () => ipcRenderer.invoke('js8call-check-setup'),

  // One-click setup: what would change, then do it, then start JS8Call.
  // planSetup is read-only; applySetup writes JS8Call.ini (backed up first, and
  // refused while JS8Call runs, because Qt rewrites the file on exit).
  planSetup: (opts) => ipcRenderer.invoke('js8call-plan-setup', opts),
  applySetup: (opts) => ipcRenderer.invoke('js8call-apply-setup', opts),
  launch: () => ipcRenderer.invoke('js8call-launch'),
  // The SmartSDR DAX control panel. POTACAT does not need it (Flex Direct
  // streams VITA-49), but JS8Call cannot reach the radio without it.
  launchDax: () => ipcRenderer.invoke('js8call-launch-dax'),
  launchCat: () => ipcRenderer.invoke('js8call-launch-cat'),

  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Per-window zoom, same convention as the other popouts.
  setZoom: (z) => webFrame.setZoomFactor(z),
  getZoom: () => webFrame.getZoomFactor(),
});
