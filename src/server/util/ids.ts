/**
 * Monotonic, prefix-scoped id generation.
 *
 * Ids must be a pure function of how many have been issued — the replay harness
 * builds a fresh factory per run so two arms of an A/B eval see byte-identical
 * event ids.
 */

export function makeIdFactory(prefix: string): () => string {
  const p = prefix.toUpperCase();
  let n = 0;
  return () => `${p}-${String(++n).padStart(6, '0')}`;
}
