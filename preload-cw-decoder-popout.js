const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  onSmartSdrAudio: (cb) => {
    let ackCount = 0;
    const flush = () => {
      if (ackCount > 0) {
        ipcRenderer.send('audio-ack', { channel: 'smartsdr-audio-frame', count: ackCount });
        ackCount = 0;
      }
    };
    ipcRenderer.on('smartsdr-audio-frame', (_e, d) => {
      if (++ackCount >= 8) flush();
      try { cb(d); } catch {}
    });
    setInterval(flush, 250);
  },
  onTheme: (cb) => ipcRenderer.on('cw-decoder-popout-theme', (_e, theme) => cb(theme)),
  minimize: () => ipcRenderer.send('cw-decoder-popout-minimize'),
  maximize: () => ipcRenderer.send('cw-decoder-popout-maximize'),
  close: () => ipcRenderer.send('cw-decoder-popout-close'),
});
