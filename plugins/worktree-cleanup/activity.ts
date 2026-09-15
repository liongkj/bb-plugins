/**
 * Return the most recent timestamp that represents meaningful worktree
 * activity. Directory mtimes are deliberately not accepted here: creating or
 * removing an ignored cache changes a parent directory mtime without changing
 * source work.
 */
export function newestMeaningfulTimestamp(commitTimestampMs: number | null, fileTimestamps: readonly number[]): number {
  let newest = Number.isFinite(commitTimestampMs) && (commitTimestampMs ?? 0) >= 0 ? commitTimestampMs! : 0;
  for (const timestamp of fileTimestamps) {
    if (Number.isFinite(timestamp) && timestamp >= 0) newest = Math.max(newest, timestamp);
  }
  return newest;
}

export function unixTimestampMs(value: string): number | null {
  const seconds = Number(value.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}
