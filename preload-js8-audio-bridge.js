// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Preload for the JS8Call audio bridge. contextBridge only — the bridge window
// runs untrusted-by-default like every other renderer here.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  ready: () => ipcRenderer.send('js8-audio-ready'),

  // {enabled, rxDeviceId, txDeviceId} — what to play into and record from.
  onConfig: (cb) => ipcRenderer.on('js8-audio-config', (_e, cfg) => cb(cfg)),

  // Slice receive audio, the same VITA-49 frames JTCAT and ECHOCAT get.
  onAudioFrame: (cb) => ipcRenderer.on('smartsdr-audio-frame', (_e, f) => cb(f)),

  // Tell main we consumed frames. Main's backpressure guard counts unacked
  // frames and starts dropping at the cap — a consumer that never acks looks
  // exactly like one that has stalled, and gets throttled to nothing.
  ack: (count) => ipcRenderer.send('audio-ack', { channel: 'smartsdr-audio-frame', count: count }),

  // JS8Call's transmit audio, 24 kHz mono Float32, on its way to dax_tx.
  txChunk: (buf) => ipcRenderer.send('js8-audio-tx-chunk', buf),

  onListDevices: (cb) => ipcRenderer.on('js8-audio-list-devices', () => cb()),
  devices: (list) => ipcRenderer.send('js8-audio-devices', list),

  status: (s) => ipcRenderer.send('js8-audio-status', s),
});
