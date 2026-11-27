import { on } from "./bus.js";
export async function listen(ev, cb) { return on(ev, cb); }
export async function emit() {}
