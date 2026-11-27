const subs = new Map();
export function on(ev, cb) {
  if (!subs.has(ev)) subs.set(ev, new Set());
  subs.get(ev).add(cb);
  return () => subs.get(ev)?.delete(cb);
}
export function fire(ev, payload) {
  for (const cb of subs.get(ev) || []) cb({ event: ev, payload });
}
