// Concurrency control for a matchday: how many engines may run at once, and the order-preserving
// bounded map that honours it.
import os from 'node:os';

// A matchday sims the WHOLE world (every division's round + any cup ties) — ~16 engine processes at once.
// Promise.all fired them ALL concurrently, which on a modest player's box (a 4-core laptop) means 16 native
// engines + node + vite fighting over a handful of cores — a real crash/swap risk. Cap the in-flight engines
// at the box's own parallelism: a 16-core host still runs the round in one wave (this box is throughput-bound,
// not oversubscription-bound, so a smaller cap only adds batch barriers), a 4-core box runs ~3 at a time.
// FOOTY_MATCH_CONCURRENCY overrides for a tuned deploy. Order-preserving so callers can index results by
// position. (No-op vs Promise.all when the cap >= items.length.)
const envCap = Math.floor(Number(process.env.FOOTY_MATCH_CONCURRENCY));
export const MATCH_CONCURRENCY = Number.isFinite(envCap) && envCap >= 1
  ? envCap
  : Math.max(2, (os.availableParallelism?.() ?? 4) - 1);
export async function mapPool<T, R>(items: T[], fn: (item: T) => Promise<R>, limit = MATCH_CONCURRENCY): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
