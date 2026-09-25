// Threshold tuning for the hybrid checker's Jev tags, used by `npm run eval -- --sweep`.

export const CANDIDATES = Array.from({ length: 19 }, (_, i) => Math.round((0.05 + i * 0.05) * 100) / 100);

/**
 * For one tag, pick the threshold with the highest recall whose precision is at least target.precision.
 * Ties go to the higher threshold, which flags less. A threshold that catches no flawed clause is skipped,
 * so "flags nothing" never passes as 100% precision. meetsTarget is false when the best recall is below
 * target.recall, which is the spec's trigger for moving the tag back to the LLM. Returns null if no
 * threshold reaches the precision target.
 */
export function pickThreshold(rows, itemsById, tag, target) {
  let best = null;
  for (const t of CANDIDATES) {
    let tp = 0, fp = 0, fn = 0;
    for (const row of rows) {
      const item = itemsById.get(row.id);
      const want = item.tags.includes(tag);
      const got = row.jev[tag] >= t;
      const allowed = want || (item.also_ok ?? []).includes(tag);
      if (want && got) tp++;
      else if (want && !got) fn++;
      else if (!allowed && got) fp++;
    }
    if (tp === 0) continue;
    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    if (precision >= target.precision && (!best || recall >= best.recall)) best = { t, precision, recall };
  }
  return best ? { ...best, meetsTarget: best.recall >= target.recall } : null;
}
