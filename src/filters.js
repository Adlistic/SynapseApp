// ClaudeConnect-level message filtering for Synapse 2.
// Per-kind toggles + 14 tool-category sub-toggles + a "collapse to a dot vs
// hide" mode for filtered tool calls. Persisted to localStorage.

const STORAGE_KEY = "synapse2.filters.v1";

// Top-level message kinds (mapped to synapse-core MessageKind strings).
export const KINDS = [
  { key: "user", label: "you", color: "#7c9cff" },
  { key: "text", label: "text", color: "#d6e1ff" },
  { key: "question", label: "questions", color: "#ffd479" },
  { key: "thinking", label: "thinking", color: "#8a93a6" },
  { key: "tool_use", label: "tool calls", color: "#5ad0c4" },
  { key: "tool_result", label: "results", color: "#9fb0c9" },
  { key: "error", label: "errors", color: "#ff6b6b" },
  { key: "plan", label: "plans", color: "#c08bff" },
];

// Researched, calm, desaturated palette for dark UI (good contrast on the dark
// base, low eye-strain, semantically meaningful — see message-color notes).
// Message-kind colors (shared by bubbles + settings rows).
export const KIND_COLOR = {
  user: "#8fb0ff",       // calm periwinkle — trust / your voice
  message: "#d6e1ff",    // soft off-white — main reading text (not pure white)
  question: "#f2c879",   // warm amber — gentle attention
  thinking: "#9a93c4",   // muted lavender — calm, recedes
  toolcall: "#5ad0c4",   // teal — active work
  toolresult: "#9fb0c9", // muted blue-grey — neutral output
  error: "#f0786e",      // soft coral — clear but not alarming
  plan: "#b794f6",       // muted violet — strategy / creativity
  other: "#9aa6bd",
};

// The 14 tool categories (synapse-core ToolCategory kebab strings → label/color).
export const TOOL_CATS = [
  { key: "shell", label: "shell", color: "#56c7bd" },        // teal — action
  { key: "file-read", label: "file read", color: "#8fb3d9" }, // cool blue — passive read
  { key: "file-write", label: "file write", color: "#7fcf9b" }, // sage green — creation/growth
  { key: "search", label: "search", color: "#6fc7d6" },      // cyan
  { key: "web", label: "web", color: "#6fa3e8" },            // blue
  { key: "tasks", label: "tasks", color: "#e6c06a" },        // gold
  { key: "subagents", label: "subagents", color: "#b79af0" }, // violet
  { key: "ask-user", label: "ask", color: "#f0a868" },       // warm orange — human attention
  { key: "scheduling", label: "schedule", color: "#aed480" }, // lime-green
  { key: "notifications", label: "notify", color: "#e88fb5" }, // soft pink
  { key: "plan", label: "plan", color: "#b794f6" },          // violet
  { key: "worktrees", label: "worktree", color: "#6fd0b0" }, // teal-green
  { key: "mcp", label: "mcp", color: "#a99af0" },            // periwinkle-violet
  { key: "other", label: "other", color: "#9aa6bd" },        // neutral grey
];

export const DEFAULT_FILTERS = {
  user: true,
  text: true,
  question: true,
  thinking: false, // noisy; off by default, like ClaudeConnect
  tool_use: true,
  tool_result: true,
  error: true,
  plan: true,
  toolCategories: Object.fromEntries(TOOL_CATS.map((c) => [c.key, true])),
  filteredToolDisplay: "dot", // "dot" = collapse to a marker, "hidden" = remove
  recentFoldersLimit: 5, // how many recent folders to list on the launch screen
  backgroundMode: "none", // "none" | "color" | "aurora"
  backgroundColor: { h: 222, s: 47, l: 11 },
  warpSpeed: 1, // aurora blob speed: 0 (off) | 0.5 | 1 | 2 | 4
  tabPosition: "top", // "top" | "left"
  showComposer: false, // input box under the terminal (off = type in the console)
  theme: "dark", // "dark" | "light" | "system"
  accent: null, // custom accent hex (null = palette default)
  notifyOnFinish: true, // Windows toast when a background session finishes work
};

// Accent presets (applied to --accent). First = the HyperVoice brand default
// (sky blue); the rest are brand + suite colors: orange, gold, green, the
// desktop-app blue and violet.
export const ACCENT_PRESETS = ["#27B8FD", "#F97316", "#FFC700", "#22C55E", "#3B82F6", "#7C3AED"];

// Background presets (ClaudeConnect's dark-tone set).
export const BG_PRESETS = [
  { name: "Slate", h: 222, s: 47, l: 11 },
  { name: "Indigo", h: 244, s: 47, l: 14 },
  { name: "Emerald", h: 150, s: 60, l: 8 },
  { name: "Rose", h: 345, s: 50, l: 10 },
  { name: "Amber", h: 30, s: 60, l: 8 },
  { name: "Cyan", h: 186, s: 70, l: 8 },
  { name: "Violet", h: 270, s: 55, l: 12 },
  { name: "Black", h: 0, s: 0, l: 0 },
];

// --- Recent folders (most-recent-first, deduped) ---------------------------
const RECENT_KEY = "synapse2.recentFolders.v1";

export function loadRecentFolders() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function addRecentFolder(path) {
  if (!path || !path.trim()) return loadRecentFolders();
  try {
    let list = loadRecentFolders().filter((p) => p !== path);
    list.unshift(path);
    list = list.slice(0, 30);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    return list;
  } catch {
    return loadRecentFolders();
  }
}

// --- Theme-aware display colors ---------------------------------------------
// The kind/category palette is tuned for dark backgrounds. On white, scaling
// brightness turns warm hues to mud — instead keep the hue, clamp lightness.
function hexParts(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return { h: 220, s: 20, l: 50 };
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

// Text/border color readable on the current surface.
export function displayColor(hex, light) {
  if (!light) return hex;
  const { h, s } = hexParts(hex);
  return `hsl(${h} ${Math.min(Math.round(s * 1.2), 90)}% 34%)`;
}

// Badge styling for the tool pills: tinted background + readable text/border
// in BOTH themes (dark keeps the original hue; light gets a deep variant).
export function pillStyle(hex, light) {
  const { h, s, l } = hexParts(hex);
  if (light) {
    const ds = Math.min(Math.round(s * 1.2), 90);
    return {
      color: `hsl(${h} ${ds}% 32%)`,
      borderColor: `hsl(${h} ${ds}% 60% / 0.7)`,
      background: `hsl(${h} ${ds}% 50% / 0.09)`,
    };
  }
  return {
    color: hex,
    borderColor: `hsl(${h} ${s}% ${l}% / 0.55)`,
    background: `hsl(${h} ${s}% ${l}% / 0.08)`,
  };
}

// --- Custom session titles (sessionId → name) -------------------------------
const TITLES_KEY = "synapse2.titles.v1";

export function loadTitles() {
  try {
    const raw = localStorage.getItem(TITLES_KEY);
    const map = raw ? JSON.parse(raw) : {};
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

// Save (or clear, when name is empty) a custom title; returns the new map.
export function saveTitle(sessionId, name) {
  try {
    const map = loadTitles();
    if (name) map[sessionId] = name;
    else delete map[sessionId];
    localStorage.setItem(TITLES_KEY, JSON.stringify(map));
    return { ...map };
  } catch {
    return loadTitles();
  }
}

export function loadFilters() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const p = JSON.parse(raw);
    return {
      ...DEFAULT_FILTERS,
      ...p,
      toolCategories: { ...DEFAULT_FILTERS.toolCategories, ...(p.toolCategories || {}) },
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function saveFilters(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

// The category that applies to a message. tool_result rows don't carry a
// category of their own, so we inherit it from the originating tool_use via
// tool_use_id (catById), matching ClaudeConnect.
export function resolveCategory(m, catById) {
  if (m.kind === "toolcall") return m.toolCategory || "other";
  if (m.kind === "toolresult") return catById[m.toolUseId] || m.toolCategory || "other";
  return null;
}

// 'full' | 'dot' | 'hidden'
export function messageDisplay(m, s, catById) {
  switch (m.kind) {
    case "user": return s.user ? "full" : "hidden";
    case "message": return s.text ? "full" : "hidden";
    case "question": return s.question ? "full" : "hidden";
    case "thinking": return s.thinking ? "full" : "hidden";
    case "error": return s.error ? "full" : "hidden";
    case "plan": return s.plan ? "full" : "hidden";
    case "toolcall": {
      const cat = resolveCategory(m, catById);
      const out = !s.tool_use || s.toolCategories[cat] === false;
      return out ? (s.filteredToolDisplay || "dot") : "full"; // "dot" | "pill" | "hidden"
    }
    case "toolresult": {
      const cat = resolveCategory(m, catById);
      const out = !s.tool_result || s.toolCategories[cat] === false;
      return out ? (s.filteredToolDisplay || "dot") : "full";
    }
    default: return s.text ? "full" : "hidden";
  }
}
