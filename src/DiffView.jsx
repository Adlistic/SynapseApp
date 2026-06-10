import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { diffLines } from "diff";

const COLLAPSE_THRESHOLD = 20;

function splitLines(v) {
  if (v == null || v === "") return [];
  const parts = String(v).split("\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function buildRows(oldStr, newStr) {
  const chunks = diffLines(oldStr ?? "", newStr ?? "");
  const rows = [];
  let o = 1, n = 1;
  for (const c of chunks) {
    const lines = splitLines(c.value);
    if (c.added) lines.forEach((t) => rows.push({ kind: "add", o: null, n: n++, t }));
    else if (c.removed) lines.forEach((t) => rows.push({ kind: "remove", o: o++, n: null, t }));
    else lines.forEach((t) => rows.push({ kind: "context", o: o++, n: n++, t }));
  }
  return rows;
}

function buildWriteRows(content) {
  return splitLines(content).map((t, i) => ({ kind: "add", o: null, n: i + 1, t }));
}

function countChanges(rows) {
  return rows.filter((r) => r.kind !== "context").length;
}

function normalize(editData, toolName) {
  if (!editData) return null;
  const tn = toolName || "";
  const filePath = editData.file_path || editData.path || editData.notebook_path || "";
  if (tn === "Write") {
    return { filePath, label: "Writing new file", blocks: [{ rows: buildWriteRows(editData.content || "") }] };
  }
  if (tn === "MultiEdit" && Array.isArray(editData.edits)) {
    const blocks = editData.edits.map((e, i) => ({
      rows: buildRows(e.old_string, e.new_string),
      subtitle: editData.edits.length > 1 ? `Edit ${i + 1} of ${editData.edits.length}` : null,
    }));
    return { filePath, label: `Editing file (${editData.edits.length} edits)`, blocks };
  }
  if (editData.old_string != null || editData.new_string != null) {
    return { filePath, label: "Editing file", blocks: [{ rows: buildRows(editData.old_string, editData.new_string) }] };
  }
  return null;
}

function DiffRows({ blocks }) {
  return (
    <>
      {blocks.map((b, i) => (
        <div key={i}>
          {b.subtitle && <div className="diff-sub">{b.subtitle}</div>}
          {b.rows.map((r, j) => (
            <div key={j} className={"diff-row " + r.kind}>
              <span className="diff-num">{r.o ?? ""}</span>
              <span className="diff-num">{r.n ?? ""}</span>
              <span className="diff-sign">{r.kind === "add" ? "+" : r.kind === "remove" ? "-" : " "}</span>
              <span className="diff-text">{r.t}</span>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

// Fullscreen diff (90vw × 90vh), portaled to body — like ClaudeConnect.
function DiffModal({ norm, totalChanges, adds, dels, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="diff-modal-backdrop" onClick={onClose}>
      <div className="diff-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="diff-modal-head">
          <span className="diff-modal-label">{norm.label}</span>
          <span className="diff-modal-path" title={norm.filePath}>{norm.filePath || "(no path)"}</span>
          <span className="diff-modal-stat add">+{adds}</span>
          <span className="diff-modal-stat del">−{dels}</span>
          <span className="diff-modal-stat">{totalChanges} changes</span>
          <button className="diff-modal-x" onClick={onClose} aria-label="Close diff">✕</button>
        </div>
        <div className="diff-modal-body diff-body-rows">
          <DiffRows blocks={norm.blocks} />
        </div>
        <div className="diff-modal-foot">Esc or click outside to close</div>
      </div>
    </div>,
    document.body
  );
}

export default function DiffView({ editData, toolName }) {
  const norm = useMemo(() => normalize(editData, toolName), [editData, toolName]);
  const { totalChanges, adds, dels } = useMemo(() => {
    if (!norm) return { totalChanges: 0, adds: 0, dels: 0 };
    let a = 0, d = 0;
    for (const b of norm.blocks) for (const r of b.rows) { if (r.kind === "add") a++; else if (r.kind === "remove") d++; }
    return { totalChanges: a + d, adds: a, dels: d };
  }, [norm]);
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(false);

  if (!norm || totalChanges === 0) return null;
  const collapsible = totalChanges > COLLAPSE_THRESHOLD;
  const showDiff = collapsible ? open : true;

  return (
    <div className="diff">
      <div className="diff-head">
        <span className="diff-label">{norm.label}</span>
        <span className="diff-path" title={norm.filePath}>{norm.filePath}</span>
        <button className="diff-max" onClick={() => setModal(true)} title="Expand to fullscreen">⛶</button>
      </div>
      {collapsible && (
        <button className="diff-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? "▾ Hide diff" : `▸ Show diff (${totalChanges} changes)`}
        </button>
      )}
      {showDiff && (
        <div className="diff-body diff-body-rows">
          <DiffRows blocks={norm.blocks} />
        </div>
      )}
      {modal && <DiffModal norm={norm} totalChanges={totalChanges} adds={adds} dels={dels} onClose={() => setModal(false)} />}
    </div>
  );
}
