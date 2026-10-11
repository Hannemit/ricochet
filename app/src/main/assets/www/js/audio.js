// Small synthesised sound effects; no audio files needed.
(function (root) {
  'use strict';

  let ctx = null;
  const sound = { enabled: true };

  // Browsers only allow audio after a touch, so this is called from the first one.
  sound.unlock = function () {
    try {
      if (!ctx) ctx = new (root.AudioContext || root.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
    } catch (e) {
      ctx = null;
    }
  };

  function note(freq, at, length, volume, type) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t = ctx.currentTime + at;
    osc.type = type || 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + length + 0.05);
  }

  function play(notes) {
    if (!sound.enabled || !ctx || ctx.state !== 'running') return;
    try {
      for (const n of notes) note(n[0], n[1], n[2], n[3], n[4]);
    } catch (e) { /* audio is optional */ }
  }

  // Rising arpeggio for a solved target; `perfect` adds a sparkle on top.
  sound.solved = function (perfect) {
    const notes = [[523.25, 0, 0.5, 0.22], [659.25, 0.09, 0.5, 0.22], [783.99, 0.18, 0.55, 0.22], [1046.5, 0.27, 0.9, 0.24]];
    if (perfect) notes.push([1567.98, 0.4, 0.9, 0.12, 'sine'], [2093, 0.5, 1.1, 0.1, 'sine']);
    play(notes);
  };
  sound.timeUp = function () { play([[392, 0, 0.35, 0.2], [293.66, 0.16, 0.6, 0.2]]); };
  sound.tick = function () { play([[880, 0, 0.07, 0.07, 'sine']]); };
  sound.bid = function () { play([[659.25, 0, 0.16, 0.14], [987.77, 0.07, 0.22, 0.14]]); };
  sound.fail = function () { play([[220, 0, 0.3, 0.16, 'sawtooth'], [174.61, 0.14, 0.45, 0.16, 'sawtooth']]); };

  root.RR = Object.assign(root.RR || {}, { sound });
})(self);
