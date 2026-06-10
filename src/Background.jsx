// App background layer (ClaudeConnect-style): solid color, animated aurora
// blobs, or none. Sits fixed behind all content.
//
// The blend mode is load-bearing (ported from ClaudeConnect): in dark mode the
// blobs ADD light via 'screen' for the glow look; in light mode they tint the
// near-white base DOWNWARD via 'multiply', so the aurora reads as a soft
// watercolor instead of a murky wash.
export default function Background({ mode, color, speed = 1, light = false }) {
  const c = color || { h: 222, s: 47, l: 11 };
  if (mode === "none") return null;

  if (mode === "color") {
    // Light theme renders the chosen hue as a pale-but-visible tint; dark
    // theme brightens/saturates the stored tone a touch so it reads against
    // the app's own navy instead of vanishing into it.
    const bg = light
      ? `hsl(${c.h} ${Math.min(c.s + 10, 60)}% 86%)`
      : `hsl(${c.h} ${Math.min(c.s + 12, 70)}% ${Math.min(c.l + 5, 24)}%)`;
    return <div className="bg-layer" style={{ background: bg }} />;
  }

  // aurora — a few drifting blurred blobs over a themed base.
  // `speed` scales the drift: 0 = still, 1 = normal, up to 4 = warp.
  const sp = speed ?? 1;
  const playState = sp > 0 ? "running" : "paused";
  const dur = (base) => ({ animationDuration: sp > 0 ? `${base / sp}s` : "0s", animationPlayState: playState });
  const base = light
    ? `hsl(${c.h} 40% 94%)`
    : `hsl(${c.h} ${c.s}% ${Math.max(4, c.l - 4)}%)`;
  const blend = light ? "multiply" : "screen";
  const blob = (hue) => (light ? `hsl(${hue} 65% 78%)` : `hsl(${hue} 70% 55%)`);
  return (
    <div className={"bg-layer aurora" + (light ? " light" : "")} style={{ background: base }}>
      <div className="blob b1" style={{ background: blob(c.h), mixBlendMode: blend, ...dur(26) }} />
      <div className="blob b2" style={{ background: blob((c.h + 60) % 360), mixBlendMode: blend, ...dur(32) }} />
      <div className="blob b3" style={{ background: blob((c.h + 280) % 360), mixBlendMode: blend, ...dur(38) }} />
    </div>
  );
}
