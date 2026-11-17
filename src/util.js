// Shared helpers: project naming, local-day bucketing, number rounding.

// Claude Code encodes the project's absolute cwd as a directory name by
// replacing "/" and "." with "-". The encoding is lossy, so we use heuristics:
//   -Users-jdoe--openclaw-workspace-droid  -> "droid" (OpenClaw agent workspace)
//   -Users-jdoe--openclaw                   -> "openclaw"
//   -Users-jdoe-repos                       -> "repos"
export function friendlyProjectName(projectDir) {
  if (!projectDir) return 'unknown';
  const workspaceMatch = projectDir.match(/workspace-([^/]+)$/);
  if (workspaceMatch) return workspaceMatch[1];
  const withoutHome = projectDir.replace(/^-(?:Users|home)-[^-]+-/, '').replace(/^-+/, '');
  if (withoutHome) return withoutHome;
  return projectDir.replace(/^-+/, '') || 'root';
}

// Returns YYYY-MM-DD for the timestamp in the given IANA time zone.
const dayFormatterCache = new Map();
export function localDay(timestamp, timeZone) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  let formatter = dayFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatterCache.set(timeZone, formatter);
  }
  return formatter.format(date); // en-CA formats as YYYY-MM-DD
}

export function localMonth(timestamp, timeZone) {
  const day = localDay(timestamp, timeZone);
  return day ? day.slice(0, 7) : null;
}

export function roundUsd(value) {
  return Math.round(value * 1e6) / 1e6;
}

export function sortedEntries(objectMap) {
  return Object.entries(objectMap).sort(([left], [right]) => left.localeCompare(right));
}
