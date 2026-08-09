// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Preload for the JS8 message view. contextBridge only — no Node reaches
// the renderer. JS8 is native (lib/js8-engine.js): the surface here is
// start/stop, heartbeat, transmit, and the conversation store. The
// bridge-era setup/launch/slice/audio-cable channels are gone with the
// bridge itself.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  // Window chrome (the popout is frameless off macOS).
  minimizeWindow: () => ipcRenderer.send('js8call-popout-minimize'),
  maximizeWindow: () => ipcRenderer.send('js8call-popout-maximize'),
  closeWindow: () => ipcRenderer.send('js8call-popout-close'),

  // Engine state: { running, tx, txQueue, submode, heartbeat, heartbeatMin,
  // station:{call,grid} }.
  onStatus: (cb) => ipcRenderer.on('js8call-status', (_e, s) => cb(s)),
  // One decoded line. `replay:true` marks the backfill sent on window open.
  onActivity: (cb) => ipcRenderer.on('js8call-activity', (_e, a) => cb(a)),
  onTheme: (cb) => ipcRenderer.on('js8call-popout-theme', (_e, t) => cb(t)),

  // JS8 lifecycle — it runs as the JTCAT engine, so "start" is JTCAT in JS8
  // mode and every audio route and guard applies.
  start: () => ipcRenderer.invoke('js8-start'),
  stop: () => ipcRenderer.invoke('js8-stop'),
  // Heartbeat scheduler (the Auto toggle): {enabled?, intervalMin?}.
  // Session-only enable, 30-minute attended watchdog (Part 97).
  heartbeat: (opts) => ipcRenderer.invoke('js8-heartbeat', opts),
  // Send ONE heartbeat now (the HB button), every press.
  sendHeartbeat: () => ipcRenderer.invoke('js8-send-hb'),
  // Send-result / refusal channel (SWR trip, radio busy, etc.).
  onSendResult: (cb) => ipcRenderer.on('js8call-send-result', (_e, r) => cb(r)),

  // Transmit. Returns {ok, error, text, frames} so a refusal can be shown
  // rather than silently doing nothing. Pass the destination separately:
  // main owns the addressing rules.
  send: (text, to) => ipcRenderer.invoke('js8call-send', { text, to }),

  // Log this conversation as a QSO. Main extracts the exchange (reports each
  // way, latest-session times, grid, dial+offset) and opens the standard Log
  // window prefilled — the same door the spot Log button uses.
  logThread: (id) => ipcRenderer.invoke('js8-log-prefill', id),

  // Conversations. State is owned by main (lib/js8call-threads.js) so unread
  // counts survive this window closing — an inbox that forgets is a log.
  threads: () => ipcRenderer.invoke('js8call-threads'),
  thread: (id) => ipcRenderer.invoke('js8call-thread', id),
  threadClosed: () => ipcRenderer.send('js8call-thread-closed'),
  onThreads: (cb) => ipcRenderer.on('js8call-threads', (_e, d) => cb(d)),

  // Who is audible right now (built from our own decodes — no one to "ask").
  onHeard: (cb) => ipcRenderer.on('js8call-heard', (_e, list) => cb(list)),

  // The one rig-control dispatcher — used here for the ATU match cycle.
  rigControl: (data) => ipcRenderer.invoke('rig-control', data),

  // Band: tune the rig to a band's JS8 dial (main owns the table), and the
  // live frequency stream every window gets.
  setBand: (band) => ipcRenderer.invoke('js8-set-band', band),
  onCatFrequency: (cb) => ipcRenderer.on('cat-frequency', (_e, hz) => cb(hz)),

  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Per-window zoom, same convention as the other popouts.
  setZoom: (z) => webFrame.setZoomFactor(z),
  getZoom: () => webFrame.getZoomFactor(),
});
