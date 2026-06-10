// App background layer (ClaudeConnect-style): solid color, animated aurora
// blobs, or none. Sits fixed behind all content.
export default function Background({ mode, color, speed = 1 }) {
  const c = color || { h: 222, s: 47, l: 11 };
  if (mode === "none") return null;

  if (mode === "color") {
    return <div className="bg-layer" style={{ background: `hsl(${c.h} ${c.s}% ${c.l}%)` }} />;
  }

  // aurora — a few drifting blurred blobs over a slightly darker base.
  // `speed` scales the drift: 0 = still, 1 = normal, up to 4 = warp.
  const sp = speed ?? 1;
  const playState = sp > 0 ? "running" : "paused";
  const dur = (base) => ({ animationDuration: sp > 0 ? `${base / sp}s` : "0s", animationPlayState: playState });
  const base = `hsl(${c.h} ${c.s}% ${Math.max(4, c.l - 4)}%)`;
  return (
    <div className="bg-layer aurora" style={{ background: base }}>
      <div className="blob b1" style={{ background: `hsl(${c.h} 70% 55%)`, ...dur(26) }} />
      <div className="blob b2" style={{ background: `hsl(${(c.h + 60) % 360} 70% 55%)`, ...dur(32) }} />
      <div className="blob b3" style={{ background: `hsl(${(c.h + 280) % 360} 70% 55%)`, ...dur(38) }} />
    </div>
  );
}
