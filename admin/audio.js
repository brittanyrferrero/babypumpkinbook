"use strict";
// Shared by /admin and /record (loaded as /admin/audio.js).

// Any audio or video file → a small, level-matched mono mp3 (sound only).
// Done in the browser so phone videos of any size fit, and every recording
// plays at the same loudness as the AI-read ones.
let lameLoading = null;
function loadLame() {
  return (lameLoading ||= new Promise((ok, no) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js";
    s.onload = ok; s.onerror = () => no(new Error("Couldn't load the mp3 encoder. Check the connection and try again."));
    document.head.appendChild(s);
  }));
}
async function toMp3(file) {
  const RATE = 44100;
  const [, buf] = await Promise.all([loadLame(), file.arrayBuffer()]);
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let decoded;
  try { decoded = await new Promise((ok, no) => ctx.decodeAudioData(buf, ok, no)); }
  catch { throw new Error("Couldn't read the sound in that file. Try an mp3, m4a or mp4."); }
  finally { ctx.close && ctx.close(); }
  if (decoded.duration > 300) throw new Error("That's over 5 minutes. Please trim it to just the fact.");
  // mix to mono at 44.1 kHz
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * RATE), RATE);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const x = (await off.startRendering()).getChannelData(0);
  // trim silence: keep 0.15 s before the first sound and 0.6 s after the last
  // "sound" means within 26 dB of the loudest moment, so quiet recordings work too
  let top = 0; for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > top) top = v; }
  if (top < 1e-4) throw new Error("That file seems to be silent.");
  const thr = top * 0.05; let a = 0, b = x.length - 1;
  while (a < x.length && Math.abs(x[a]) < thr) a++;
  while (b > a && Math.abs(x[b]) < thr) b--;
  if (a >= b) throw new Error("That file seems to be silent.");
  a = Math.max(0, a - Math.round(0.15 * RATE)); b = Math.min(x.length, b + Math.round(0.6 * RATE));
  const y = x.slice(a, b);
  // level: about -17 LUFS like the AI clips (speech RMS ≈ -14 dBFS), peaks no higher than -1.5 dBFS
  let sum = 0, n = 0, peak = 0;
  for (let i = 0; i < y.length; i++) { const v = Math.abs(y[i]); if (v > peak) peak = v; if (v > thr) { sum += v * v; n++; } }
  const rms = Math.sqrt(sum / Math.max(1, n));
  const gain = Math.min(0.2 / rms, 0.84 / peak);
  const pcm = new Int16Array(y.length);
  for (let i = 0; i < y.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(y[i] * gain * 32767)));
  const enc = new lamejs.Mp3Encoder(1, RATE, 128), parts = [];
  for (let i = 0; i < pcm.length; i += 1152) { const o = enc.encodeBuffer(pcm.subarray(i, i + 1152)); if (o.length) parts.push(new Uint8Array(o)); }
  const end = enc.flush(); if (end.length) parts.push(new Uint8Array(end));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return { bytes: out, seconds: y.length / RATE };
}
