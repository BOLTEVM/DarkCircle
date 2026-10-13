/** "in 3 days", "in 5 hours", "expired 2 days ago". */
export function relativeTime(targetSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const diff = targetSeconds - nowSeconds;
  const abs = Math.abs(diff);
  const [n, unit] = abs >= 86_400 ? [Math.round(abs / 86_400), 'day'] : abs >= 3_600 ? [Math.round(abs / 3_600), 'hour'] : [Math.max(1, Math.round(abs / 60)), 'minute'];
  const phrase = `${n} ${unit}${n === 1 ? '' : 's'}`;
  return diff >= 0 ? `in ${phrase}` : `${phrase} ago`;
}

export function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Storeys for the illustrative massing: from interior area over the buildable footprint, else by type. */
export function estimateStoreys(type: string, interiorSqm: number | undefined, lotSqm: number | null): number {
  if (type === 'land') return 0;
  if (interiorSqm && lotSqm && lotSqm > 0) return Math.min(40, Math.max(1, Math.ceil(interiorSqm / (lotSqm * 0.67))));
  return type === 'industrial' ? 1 : type === 'residential' ? 2 : 3;
}
