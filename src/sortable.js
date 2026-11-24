// Drag-to-reorder with a live preview: while you drag, the list is shown in
// the order it would have if you let go now, so items slide out of the way.
//
// Built on pointer events instead of HTML5 drag-and-drop, which only shows a
// faint ghost image and never moves the other items.
//
// Each sortable element carries data-sort-scope (which list it belongs to)
// and data-sort-id. The hook reports {kind, scope, id, index}, where index is
// the dragged item's new position among the items of that scope.
import { useEffect, useRef, useState } from "react";

const THRESHOLD = 5; // px of movement before a press becomes a drag
const EDGE = 36;     // px from a scroll edge where dragging auto-scrolls

/** `list` with the item whose key is `id` moved to `index`. */
export function moveTo(list, id, index, key = (x) => x) {
  const i = list.findIndex((x) => key(x) === id);
  if (i < 0) return list;
  const out = [...list];
  const [m] = out.splice(i, 1);
  out.splice(Math.max(0, Math.min(index, out.length)), 0, m);
  return out;
}

export function useSortDrag(onCommit) {
  const [drag, setDrag] = useState(null); // {kind, scope, id, index} while dragging
  const pending = useRef(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => {
    function indexAt(p, x, y) {
      const els = [...document.querySelectorAll("[data-sort-scope]")].filter(
        (el) => el.dataset.sortScope === p.scope && el.dataset.sortId !== p.id
      );
      const at = p.axis === "x" ? x : y;
      let n = 0;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const mid = p.axis === "x" ? r.left + r.width / 2 : r.top + r.height / 2;
        if (mid < at) n++;
      }
      return n;
    }
    function autoScroll(p, x, y) {
      const sc = p.scroller;
      if (!sc) return;
      const r = sc.getBoundingClientRect();
      if (p.axis === "x") {
        if (x < r.left + EDGE) sc.scrollLeft -= 10;
        else if (x > r.right - EDGE) sc.scrollLeft += 10;
      } else {
        if (y < r.top + EDGE) sc.scrollTop -= 10;
        else if (y > r.bottom - EDGE) sc.scrollTop += 10;
      }
    }
    function end(commit) {
      const p = pending.current;
      pending.current = null;
      document.body.classList.remove("sorting");
      if (!p?.active) return;
      // The release would also count as a click on the item: swallow it.
      const eat = (e) => { e.stopPropagation(); e.preventDefault(); };
      window.addEventListener("click", eat, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", eat, { capture: true }), 0);
      setDrag(null);
      if (commit && p.index != null && p.index !== p.startIndex) {
        commitRef.current?.({ kind: p.kind, scope: p.scope, id: p.id, index: p.index });
      }
    }
    function onMove(e) {
      const p = pending.current;
      if (!p || e.pointerId !== p.pointerId) return;
      if (!p.active) {
        if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < THRESHOLD) return;
        p.active = true;
        document.body.classList.add("sorting");
      }
      autoScroll(p, e.clientX, e.clientY);
      const index = indexAt(p, e.clientX, e.clientY);
      if (index !== p.index) {
        p.index = index;
        setDrag({ kind: p.kind, scope: p.scope, id: p.id, index });
      }
    }
    const onUp = (e) => { if (pending.current && e.pointerId === pending.current.pointerId) end(true); };
    const onCancel = () => end(false);
    const onKey = (e) => { if (e.key === "Escape" && pending.current?.active) { e.stopPropagation(); end(false); } };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Call from onPointerDown on a sortable element. */
  function begin(e, { kind, scope, id, axis = "y" }) {
    if (e.button !== 0) return;
    if (e.target.closest("button, input, textarea, a, [data-no-drag]")) return;
    const el = e.currentTarget;
    const peers = [...document.querySelectorAll("[data-sort-scope]")].filter((x) => x.dataset.sortScope === scope);
    pending.current = {
      kind, scope, id, axis,
      pointerId: e.pointerId,
      x0: e.clientX, y0: e.clientY,
      active: false,
      startIndex: peers.indexOf(el),
      index: null,
      scroller: el.closest(".tabbar-scroll, .tabbar.top"),
    };
  }

  return { drag, begin };
}
