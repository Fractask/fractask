import type { Task } from '@getshit/core';

export const SORT_KEYS = [
  'position',
  'created:desc',
  'created:asc',
  'updated:desc',
  'updated:asc',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const DEFAULT_SORT: SortKey = 'position';

const SORT_LABEL: Record<SortKey, string> = {
  position: 'Manual order',
  'created:desc': 'Newest first',
  'created:asc': 'Oldest first',
  'updated:desc': 'Recently updated',
  'updated:asc': 'Least recently updated',
};

const SORT_SHORT: Record<SortKey, string> = {
  position: 'manual',
  'created:desc': 'new → old',
  'created:asc': 'old → new',
  'updated:desc': 'recently updated',
  'updated:asc': 'stalest first',
};

export function parseSortKey(raw: string | string[] | undefined): SortKey {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return DEFAULT_SORT;
  return (SORT_KEYS as readonly string[]).includes(v) ? (v as SortKey) : DEFAULT_SORT;
}

export function sortLabel(key: SortKey): string {
  return SORT_LABEL[key];
}

export function sortShort(key: SortKey): string {
  return SORT_SHORT[key];
}

/**
 * Which timestamp the user is sorting by. Drives the inline "Nd ago" indicator
 * in task rows: shown only when the sort key picks a date, so rows stay clean
 * under the default manual order.
 */
export function dateFieldForSort(key: SortKey): 'createdAt' | 'updatedAt' | null {
  if (key === 'created:desc' || key === 'created:asc') return 'createdAt';
  if (key === 'updated:desc' || key === 'updated:asc') return 'updatedAt';
  return null;
}

export function sortTasks<T extends Pick<Task, 'createdAt' | 'updatedAt' | 'position'>>(
  tasks: T[],
  key: SortKey,
): T[] {
  // Don't mutate caller. Sibling lists are small (tens, occasionally hundreds);
  // a JS sort is fine.
  const copy = [...tasks];
  switch (key) {
    case 'position':
      return copy.sort(
        (a, b) => a.position - b.position || a.createdAt - b.createdAt,
      );
    case 'created:desc':
      return copy.sort((a, b) => b.createdAt - a.createdAt);
    case 'created:asc':
      return copy.sort((a, b) => a.createdAt - b.createdAt);
    case 'updated:desc':
      return copy.sort((a, b) => b.updatedAt - a.updatedAt);
    case 'updated:asc':
      return copy.sort((a, b) => a.updatedAt - b.updatedAt);
  }
}

/**
 * Compact, glanceable relative date. Designed for a tight row where space is
 * scarce: at most ~6 chars.
 *
 *   < 60s         → "now"
 *   < 60m         → "Nm ago"
 *   < 24h         → "Nh ago"
 *   < 7d          → "Nd ago"
 *   < 5w          → "Nw ago"
 *   same year     → "Mon D"        (e.g. "Mar 14")
 *   else          → "Mon 'YY"      (e.g. "Mar '24")
 */
export function formatRelativeDate(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (diff < minute) return 'now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 5 * week) return `${Math.floor(diff / week)}w ago`;
  const d = new Date(ts);
  const nowD = new Date(now);
  const mon = d.toLocaleString('en-US', { month: 'short' });
  if (d.getFullYear() === nowD.getFullYear()) return `${mon} ${d.getDate()}`;
  return `${mon} '${String(d.getFullYear()).slice(2)}`;
}
