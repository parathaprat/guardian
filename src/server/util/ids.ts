/**
 * Monotonic, prefix-scoped id generation. Ids are a pure function of issue
 * count so a fresh factory per run gives two eval arms byte-identical ids.
 */

/**
 * `startAt` exists so a console restarting against an existing store doesn't
 * hand out ids that collide with rows on disk. Evals never pass it, so replay stays byte-stable.
 */
export function makeIdFactory(prefix: string, startAt = 0): () => string {
  const p = prefix.toUpperCase();
  let n = startAt;
  return () => `${p}-${String(++n).padStart(6, '0')}`;
}

/** Highest numeric suffix across `PREFIX-000123` style ids, or 0 when there are none. */
export function highestSeq(ids: string[]): number {
  let max = 0;
  for (const id of ids) {
    const n = Number(id.slice(id.lastIndexOf('-') + 1));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}
