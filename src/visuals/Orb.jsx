import { useEffect, useRef, useState } from "react";

// Orb — HyperVoice Code's living "energy core", a sibling of the HyperVoice
// desktop app's VoiceOrb (same layers, same feel), drawn on one canvas:
//   1. ambient halo            4. two counter-rotating HUD arcs
//   2. orbiting particle field 5. shockwaves (state changes, bursts, invites)
//   3. 96-spoke radial ring    6. plasma core with swirling blobs + glass rim
//
// HyperVoice reacts to your microphone. HyperVoice Code has no mic, so the orb
// reacts to what you DO: every keystroke or dictated phrase that reaches the
// terminal (the `hvc:input` window event, fired by TerminalPane) pumps energy
// into the ring; a big paste or dictation sets off a shockwave.
//
// Modes:
//   idle      calm blue breathing, a slow invite pulse; typing lights it up
//   sent      a prompt went in, the agent hasn't answered: violet comet sweep
//   searching looking for sessions: cyan comet + particles drawn inward
//
// Cheap by design: ~30 fps when calm (by the clock, whatever the monitor's
// refresh rate), ~60 when busy, and it stops entirely while the window is
// hidden, scrolled away or covered (a dialog over it). Under "reduce motion"
// it slows to a gentle drift at ~10 fps with no shockwaves or flares, and it
// follows that setting (and moving to another monitor) live.

const SPOKES = 96;
const PARTICLES = 56;
const TAU = Math.PI * 2;

function prand(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Live OS settings the drawing depends on; a change re-runs the canvas setup.
function useReducedMotion() {
  const q = "(prefers-reduced-motion: reduce)";
  const [reduce, setReduce] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setReduce(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduce;
}
function useDevicePixelRatio() {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const on = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [dpr]);
  return dpr;
}

/** Tell any visible orb that the user just put `n` characters into a session. */
export function pulseInput(n, enter = false) {
  window.dispatchEvent(new CustomEvent("hvc:input", { detail: { n, enter } }));
}

export default function Orb({ mode = "idle", size = 220, className = "", reactive = true }) {
  const canvasRef = useRef(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const energy = useRef(0); // target level 0..1 from input
  const bursts = useRef(0); // pending shockwaves from big inputs
  const reduce = useReducedMotion();
  const dpr = useDevicePixelRatio();

  useEffect(() => {
    if (!reactive) return;
    const onInput = (e) => {
      const n = Math.max(1, e.detail?.n || 1);
      // A keystroke nudges; a dictated sentence or paste floods it.
      energy.current = Math.min(1, energy.current + (n === 1 ? 0.16 : 0.25 + Math.min(0.6, n / 120)));
      if (n >= 12 || e.detail?.enter) bursts.current += 1;
    };
    window.addEventListener("hvc:input", onInput);
    return () => window.removeEventListener("hvc:input", onInput);
  }, [reactive]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(canvas.width / size, 0, 0, canvas.height / size, 0, 0);

    const k = size / 300; // everything is designed at 300px and scaled
    const cx = size / 2;
    const cy = size / 2;
    const ORB_R = 52 * k;
    const motion = reduce ? 0.3 : 1;

    const particles = Array.from({ length: PARTICLES }, (_, i) => ({
      baseR: ORB_R + (18 + prand(i) * 64) * k,
      r: ORB_R + (18 + prand(i) * 64) * k,
      ang: prand(i + 100) * TAU,
      speed: (0.12 + prand(i + 200) * 0.3) * (prand(i + 300) > 0.5 ? 1 : -1),
      size: (0.8 + prand(i + 400) * 1.5) * Math.max(0.8, k),
      tw: prand(i + 500) * TAU,
      wob: prand(i + 600) * TAU,
    }));
    const waves = [];
    let smooth = 0;
    let lastMode = modeRef.current;
    let nextInvite = 1.2;
    let t = 0;
    let last = performance.now();
    let raf = 0;
    let visible = true;
    const col = (h, s, l, a) => `hsla(${h.toFixed(0)},${s.toFixed(0)}%,${l.toFixed(0)}%,${a.toFixed(3)})`;

    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      const m = modeRef.current;
      // Frame budget by the clock: ~10 fps under reduce motion, ~30 calm,
      // ~60 busy. dt spans the skipped frames so the speed holds.
      const calm = m === "idle" && smooth < 0.05;
      if (now - last < (reduce ? 95 : calm ? 31 : 15)) return;
      const dt = Math.min(reduce ? 0.12 : 0.05, (now - last) / 1000);
      last = now;
      t += dt * motion;
      const dark = document.documentElement.dataset.theme !== "light";

      // Input energy: fast attack, slow exhale; the target itself decays so a
      // burst of typing fades back to calm.
      energy.current *= Math.exp(-dt * 1.6);
      const target = energy.current;
      const tau = target > smooth ? 0.06 : 0.3;
      smooth += (target - smooth) * (1 - Math.exp(-dt / tau));
      // Under reduce motion typing only warms it a little; no flaring.
      const L = reduce ? Math.min(0.3, smooth) : smooth;

      let baseHue, accentHue;
      if (m === "sent") {
        baseHue = 262; accentHue = 228;
      } else if (m === "searching") {
        baseHue = 196 + 10 * Math.sin(t * 0.5); accentHue = 172;
      } else {
        // HV Code's own blue (#27b8fd ≈ 199°), warming toward teal as you type
        baseHue = 205 + 12 * Math.sin(t * 0.22) - L * 30;
        accentHue = baseHue - 26;
      }

      if (m !== lastMode) {
        if (!reduce) waves.push({ r: ORB_R + 2, a: 0.5, w: 2.5, h: baseHue });
        lastMode = m;
      }
      while (bursts.current > 0) {
        bursts.current -= 1;
        if (!reduce) waves.push({ r: ORB_R + 4 * k, a: 0.42, w: 2, h: accentHue });
      }
      if (m === "idle" && L < 0.1 && t > nextInvite) {
        waves.push({ r: ORB_R + 2, a: 0.2, w: 1.5, h: baseHue });
        nextInvite = t + 2.8;
      }
      if (m === "searching" && t > nextInvite) {
        // sonar ping while scanning
        waves.push({ r: ORB_R + 2, a: 0.35, w: 1.5, h: accentHue });
        nextInvite = t + 1.1;
      }

      ctx.clearRect(0, 0, size, size);
      const glow = dark ? "lighter" : "source-over";
      const lB = dark ? 0 : -8;
      ctx.globalCompositeOperation = glow;

      // 1. halo
      {
        const hr = 140 * k;
        const g = ctx.createRadialGradient(cx, cy, ORB_R * 0.4, cx, cy, hr);
        g.addColorStop(0, col(baseHue, 90, 55 + lB, dark ? 0.16 + L * 0.2 : 0.1 + L * 0.12));
        g.addColorStop(1, col(baseHue, 90, 55 + lB, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, hr, 0, TAU); ctx.fill();
      }

      // 2. particles — searching pulls them inward and respawns them outside,
      // like sessions being gathered in.
      const pSpeed = m === "idle" ? 0.35 + L * 2.5 : 1.4;
      for (const p of particles) {
        p.ang += dt * motion * p.speed * pSpeed * 3;
        if (m === "searching") {
          p.r -= dt * motion * (26 + prand(p.tw * 10) * 30) * k;
          if (p.r < ORB_R + 6 * k) p.r = p.baseR + 40 * k;
        } else {
          p.r += (p.baseR - p.r) * (1 - Math.exp(-dt * 2));
        }
        const r = p.r + 5 * k * Math.sin(t * 0.8 + p.wob);
        const fade = m === "searching" ? Math.min(1, (p.r - ORB_R) / (30 * k)) : 1;
        const tw = 0.5 + 0.5 * Math.sin(t * 2.2 + p.tw);
        const a = (0.1 + 0.4 * tw) * (m === "idle" ? 0.55 + L * 0.8 : 0.8) * fade;
        ctx.fillStyle = col(accentHue, 95, dark ? 70 : 50, Math.min(0.85, a));
        ctx.beginPath(); ctx.arc(cx + Math.cos(p.ang) * r, cy + Math.sin(p.ang) * r, p.size * (1 + L * 0.5), 0, TAU); ctx.fill();
      }

      // 3. spectrum ring
      const innerR = ORB_R + 8 * k;
      const maxLen = 34 * k;
      const head = t * (m === "searching" ? 3.2 : 2.4);
      const wrap = (x) => ((x % TAU) + TAU) % TAU;
      const dist = (ang, to) => { const d = wrap(ang - to); return Math.min(d, TAU - d); };
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(1.2, 2 * k);
      for (let i = 0; i < SPOKES; i++) {
        const ang = (i / SPOKES) * TAU - Math.PI / 2;
        const seed = Math.min(i, SPOKES - i);
        let env;
        if (m === "idle") {
          const osc = 0.5 + 0.5 * Math.sin(t * (0.6 + prand(seed) * 1.2 + L * 6) + prand(seed + 50) * TAU);
          env = 0.1 + 0.12 * osc + L * (0.2 + 0.8 * osc);
        } else {
          env = 0.08 + 0.9 * Math.exp(-dist(ang, head) * 2.2) + 0.3 * Math.exp(-dist(ang, head + Math.PI) * 2.2);
        }
        env = Math.min(1, env);
        const len = env * maxLen;
        ctx.strokeStyle = col(baseHue, 92, (dark ? 58 : 46) + 22 * env, 0.2 + 0.6 * env);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang) * innerR, cy + Math.sin(ang) * innerR);
        ctx.lineTo(cx + Math.cos(ang) * (innerR + len), cy + Math.sin(ang) * (innerR + len));
        ctx.stroke();
      }

      // 4. HUD arcs
      const arc = m === "idle" ? 1 + L * 2 : 2.2;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = col(accentHue, 90, dark ? 65 : 48, 0.4);
      ctx.beginPath(); ctx.arc(cx, cy, ORB_R + 22 * k, t * 0.7 * arc, t * 0.7 * arc + 1.9); ctx.stroke();
      ctx.strokeStyle = col(baseHue, 90, dark ? 65 : 48, 0.3);
      ctx.beginPath(); ctx.arc(cx, cy, ORB_R + 30 * k, -t * 0.4 * arc, -t * 0.4 * arc + 0.9); ctx.stroke();

      // 5. shockwaves
      for (let i = waves.length - 1; i >= 0; i--) {
        const w = waves[i];
        w.r += dt * motion * (90 + L * 80) * k;
        w.a *= Math.exp(-dt * 1.8);
        if (w.a < 0.02 || w.r > size / 2) { waves.splice(i, 1); continue; }
        // fade out with distance so a ring never pops off at the canvas edge
        const edge = Math.max(0, 1 - (w.r - ORB_R) / (size / 2 - ORB_R));
        ctx.strokeStyle = col(w.h, 92, dark ? 62 : 48, w.a * edge);
        ctx.lineWidth = w.w;
        ctx.beginPath(); ctx.arc(cx, cy, w.r, 0, TAU); ctx.stroke();
      }

      // 6. plasma core
      const coreR = ORB_R * 0.96 * (1 + 0.025 * Math.sin(t * 1.4)) * (1 + L * 0.08);
      {
        const g = ctx.createRadialGradient(cx, cy - coreR * 0.15, 0, cx, cy, coreR);
        g.addColorStop(0, col(accentHue, 80, 92, 0.95));
        g.addColorStop(0.3, col(accentHue, 92, 64 + lB, 0.9));
        g.addColorStop(0.75, col(baseHue, 92, 48 + lB, 0.92));
        g.addColorStop(1, col(baseHue, 92, 38 + lB, 0.85));
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, TAU); ctx.fill();
      }
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, TAU); ctx.clip();
      ctx.globalCompositeOperation = "lighter";
      const bs = m === "idle" ? 0.5 + L * 1.5 : 1.3;
      for (let b = 0; b < 3; b++) {
        const ph = t * bs * (0.6 + b * 0.25) + (b * TAU) / 3;
        const bx = cx + Math.cos(ph) * coreR * 0.38;
        const by = cy + Math.sin(ph * 1.3) * coreR * 0.38;
        const br = coreR * (0.45 + 0.1 * Math.sin(t * 1.1 + b * 2));
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(0, col(accentHue + b * 18, 95, 70, 0.35 + L * 0.25));
        g.addColorStop(1, col(accentHue + b * 18, 95, 70, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(bx, by, br, 0, TAU); ctx.fill();
      }
      ctx.restore();
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = `rgba(255,255,255,${dark ? 0.12 : 0.35})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, TAU); ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, coreR - 2, -2.4, -0.7); ctx.stroke();
    };

    const start = () => { if (!raf && visible && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(tick); } };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    const onVis = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVis);
    // trackVisibility also reports the orb as hidden while something covers it
    // (Resume, Settings); where unsupported, isVisible is undefined and only
    // scrolling/hiding counts.
    let io;
    const onIo = ([e]) => { visible = e.isIntersecting && e.isVisible !== false; visible ? start() : stop(); };
    try { io = new IntersectionObserver(onIo, { trackVisibility: true, delay: 250 }); } catch { io = new IntersectionObserver(onIo); }
    io.observe(canvas);
    start();
    return () => { document.removeEventListener("visibilitychange", onVis); io.disconnect(); stop(); };
  }, [size, dpr, reduce]);

  return <canvas ref={canvasRef} aria-hidden className={"hvc-orb " + className} style={{ width: size, height: size }} />;
}
