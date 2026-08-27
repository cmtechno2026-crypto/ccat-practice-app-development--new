// Deterministic seeded shuffle (Blueprint §9.2: server-controlled question/option order via
// the session's stored seeds). mulberry32 PRNG → stable per (seed), so a resumed session on the
// same device sees the same order. Correct answers reference stable option_ids, so shuffling
// options never changes correctness (§17.3).

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!; arr[i] = arr[j]!; arr[j] = tmp;
  }
  return arr;
}
