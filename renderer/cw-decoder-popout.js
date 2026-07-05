(function () {
  const $ = (id) => document.getElementById(id);
  const decoder = window.CwDecoderCore ? new window.CwDecoderCore.CwDecoderCore() : null;
  const signalGate = window.CwDecoderCore && window.CwDecoderCore.CwSignalGate
    ? new window.CwDecoderCore.CwSignalGate({ attackMs: 8, releaseMs: 32 })
    : null;

  const els = {
    audioSource: $('audio-source'),
    audioInput: $('audio-input'),
    tone: $('tone'),
    toneLabel: $('tone-label'),
    sensitivity: $('sensitivity'),
    sensitivityLabel: $('sensitivity-label'),
    autoPitch: $('auto-pitch'),
    toggle: $('decode-toggle'),
    clear: $('clear-btn'),
    status: $('status'),
    wpm: $('wpm'),
    detected: $('detected'),
    snr: $('snr'),
    keyState: $('key-state'),
    text: $('decode-text'),
    level: $('level-meter'),
    levelLabel: $('level-label'),
  };

  let active = false;
  let directAudio = false;
  let ctx = null;
  let stream = null;
  let source = null;
  let processor = null;
  let level = 0;
  let noise = 0.0005;
  let keyedState = false;
  let detectedHz = 0;
  let detectedRatio = 0;
  let lastUiMs = 0;
  let lastSettings = {};

  function toneHz() {
    return parseInt(els.tone.value, 10) || 700;
  }

  function sensitivityThreshold() {
    const pct = parseInt(els.sensitivity.value, 10) || 55;
    // Higher sensitivity means easier keying. Keep the floor low enough for
    // real-world receiver audio that sounds clear but is not normalized hot.
    return 2.6 - (pct / 100) * 1.55;
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  function updateLabels() {
    els.toneLabel.textContent = toneHz() + ' Hz';
    els.sensitivityLabel.textContent = els.sensitivity.value + '%';
  }

  function updateUi(force) {
    const now = performance.now();
    if (!force && now - lastUiMs < 70) return;
    lastUiMs = now;
    updateLabels();
    els.wpm.textContent = decoder ? (decoder.wpm + ' WPM') : '-- WPM';
    els.detected.textContent = detectedHz ? ('Detected ' + Math.round(detectedHz) + ' Hz') : 'Detected -- Hz';
    els.snr.textContent = detectedRatio ? ('SNR ' + detectedRatio.toFixed(1) + 'x') : 'SNR --';
    els.keyState.textContent = keyedState ? 'Key down' : 'Key open';
    els.keyState.style.color = keyedState ? 'var(--accent-green, #5dd683)' : 'var(--text-secondary, #b9c8dc)';
    els.text.textContent = decoder ? decoder.text : '';
    els.text.scrollTop = els.text.scrollHeight;
    const pct = Math.max(0, Math.min(100, Math.round(level * 100)));
    els.level.style.width = pct + '%';
    els.levelLabel.textContent = pct + '%';
  }

  function goertzel(samples, sampleRate, hz) {
    const n = samples.length;
    if (!n || !sampleRate) return 0;
    const k = Math.max(1, Math.round((n * hz) / sampleRate));
    const omega = (2 * Math.PI * k) / n;
    const coeff = 2 * Math.cos(omega);
    let q0 = 0, q1 = 0, q2 = 0;
    for (let i = 0; i < n; i++) {
      q0 = coeff * q1 - q2 + samples[i];
      q2 = q1;
      q1 = q0;
    }
    const power = q1 * q1 + q2 * q2 - coeff * q1 * q2;
    return (2 * Math.sqrt(Math.max(0, power))) / n;
  }

  function findPitch(samples, sampleRate) {
    let bestHz = toneHz();
    let bestTone = 0;
    let secondTone = 0;
    for (let hz = 350; hz <= 1000; hz += 25) {
      const tone = goertzel(samples, sampleRate, hz);
      if (tone > bestTone) {
        secondTone = bestTone;
        bestTone = tone;
        bestHz = hz;
      } else if (tone > secondTone) {
        secondTone = tone;
      }
    }
    return { hz: bestHz, tone: bestTone, secondTone };
  }

  function analyze(samples, sampleRate) {
    const pitch = els.autoPitch.checked ? findPitch(samples, sampleRate) : null;
    const hz = pitch ? pitch.hz : toneHz();
    const tone = pitch ? pitch.tone : goertzel(samples, sampleRate, hz);
    const low = goertzel(samples, sampleRate, Math.max(80, hz - 120));
    const high = goertzel(samples, sampleRate, hz + 120);
    const neighborhood = Math.max(0.000001, (low + high + (pitch ? pitch.secondTone : 0)) / (pitch ? 3 : 2));
    let rms = 0;
    for (let i = 0; i < samples.length; i++) rms += samples[i] * samples[i];
    rms = Math.sqrt(rms / Math.max(1, samples.length));

    const ratio = tone / Math.max(neighborhood, noise, rms * 0.05, 0.00001);
    if (ratio < 1.25 || tone < 0.00025) {
      noise = noise * 0.985 + Math.max(neighborhood, tone * 0.5, 0.00001) * 0.015;
    }
    const onThreshold = sensitivityThreshold();
    const offThreshold = Math.max(1.02, onThreshold * 0.62);
    const enoughAudio = tone > Math.max(0.00018, rms * 0.018);
    const keyed = keyedState ? (ratio > offThreshold && enoughAudio) : (ratio > onThreshold && enoughAudio);
    keyedState = keyed;
    detectedHz = hz;
    detectedRatio = ratio;
    const display = Math.max(0, Math.min(1, (ratio - 0.85) / 4.0));
    level = level * 0.65 + display * 0.35;
    return { keyed, ratio, tone, rms };
  }

  function feedSamples(samples, sampleRate) {
    if (!active || !decoder || !samples || !samples.length) return;
    const result = analyze(samples, sampleRate);
    const frameMs = (samples.length / sampleRate) * 1000;
    const segments = signalGate ? signalGate.process(result.keyed, frameMs) : [{ keyed: result.keyed, dtMs: frameMs }];
    for (const segment of segments) decoder.processKeyed(segment.keyed, segment.dtMs);
    updateUi(false);
  }

  function stop(flush) {
    if (flush !== false && decoder) decoder.flush();
    active = false;
    directAudio = false;
    if (processor) {
      processor.disconnect();
      processor.onaudioprocess = null;
      processor = null;
    }
    if (source) { source.disconnect(); source = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
    els.toggle.classList.remove('active');
    els.toggle.textContent = 'Start Decode';
    setStatus('Idle');
    updateUi(true);
  }

  async function start() {
    if (active || !decoder) return;
    decoder.reset();
    if (signalGate) signalGate.reset();
    level = 0;
    noise = 0.0005;
    keyedState = false;
    detectedHz = 0;
    detectedRatio = 0;
    active = true;
    els.toggle.classList.add('active');
    els.toggle.textContent = 'Stop Decode';
    updateUi(true);

    try {
      const settings = await window.api.getSettings();
      lastSettings = settings || {};
      const sourceMode = els.audioSource.value;
      const useDirect = sourceMode === 'direct' || (sourceMode === 'settings' && ['smartsdr', 'icom-network', 'k4-network'].includes(lastSettings.audioSource));
      if (useDirect) {
        directAudio = true;
        setStatus('Listening to direct radio audio');
        return;
      }

      const constraints = {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };
      const selected = els.audioInput.value || lastSettings.cwDecoderAudioInput || lastSettings.remoteAudioInput || '';
      if (selected) constraints.deviceId = { exact: selected };
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') await ctx.resume();
      source = ctx.createMediaStreamSource(stream);
      processor = ctx.createScriptProcessor(1024, 1, 1);
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length);
        copy.set(input);
        feedSamples(copy, ctx.sampleRate);
      };
      source.connect(processor);
      processor.connect(ctx.destination);
      setStatus('Listening to audio input');
    } catch (err) {
      console.error('[CW Decoder] start failed:', err);
      stop(false);
      setStatus('Audio failed: ' + (err && err.message ? err.message : 'unknown error'));
    }
  }

  async function loadDevices() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop())).catch(() => {});
      const devices = await navigator.mediaDevices.enumerateDevices();
      const settings = await window.api.getSettings();
      lastSettings = settings || {};
      const preferred = lastSettings.cwDecoderAudioInput || lastSettings.remoteAudioInput || '';
      els.audioInput.innerHTML = '<option value="">Default input</option>';
      devices.filter(d => d.kind === 'audioinput').forEach((d, idx) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || ('Audio input ' + (idx + 1));
        if (d.deviceId === preferred) opt.selected = true;
        els.audioInput.appendChild(opt);
      });
      if (lastSettings.audioSource && ['smartsdr', 'icom-network', 'k4-network'].includes(lastSettings.audioSource)) {
        els.audioSource.value = 'settings';
      }
    } catch (err) {
      console.warn('[CW Decoder] enumerate devices failed:', err);
    }
  }

  window.api.onSmartSdrAudio((d) => {
    if (!active || !directAudio || !d) return;
    try {
      const pcm = (d.pcm instanceof Float32Array) ? d.pcm : new Float32Array(d.pcm);
      feedSamples(pcm, d.sampleRate || 24000);
    } catch (err) {
      console.warn('[CW Decoder] direct frame failed:', err);
    }
  });

  window.api.onTheme((theme) => {
    if (window.applyPopoutTheme) window.applyPopoutTheme(theme);
  });

  $('min-btn').addEventListener('click', () => window.api.minimize());
  $('max-btn').addEventListener('click', () => window.api.maximize());
  $('close-btn').addEventListener('click', () => window.api.close());
  els.toggle.addEventListener('click', () => active ? stop(true) : start());
  els.clear.addEventListener('click', () => {
    if (decoder) decoder.reset();
    updateUi(true);
  });
  els.tone.addEventListener('input', updateUi.bind(null, true));
  els.sensitivity.addEventListener('input', updateUi.bind(null, true));
  els.autoPitch.addEventListener('change', updateUi.bind(null, true));
  els.audioInput.addEventListener('change', () => {
    window.api.saveSettings({ cwDecoderAudioInput: els.audioInput.value || '' });
    if (active && !directAudio) {
      stop(false);
      start();
    }
  });
  els.audioSource.addEventListener('change', () => {
    if (active) {
      stop(false);
      start();
    }
  });

  if (!decoder) setStatus('Decoder core failed to load');
  loadDevices();
  updateUi(true);
})();
