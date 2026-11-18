#!/usr/bin/env node
// Claude Code status line command for usage-dashboard.
//
// Claude Code runs this on every status line update with session JSON on stdin
// (https://code.claude.com/docs/en/statusline). We persist only the documented
// `rate_limits` object plus minimal metadata (capture time, session id, model
// id/name) so the dashboard can show the same percentages as /usage, then
// print a compact status line.
//
// Rules this file keeps, deliberately:
// - Never throw and always exit 0 with one line on stdout: a failing status
//   line command leaves Claude Code's footer blank.
// - No dependencies, no network, sync fs only: Claude Code cancels an in-flight
//   run when the next update arrives (300 ms debounce), and Node startup is
//   most of the budget.
// - Allow-list copy: nothing else from stdin (transcript_path, cwd, workspace,
//   cost, prompt ids...) is written to disk.
// - An input without rate_limits (non-subscriber, or before the session's first
//   API response) never overwrites an earlier capture.
// - Atomic write: unique temp file in the same directory, then rename. The
//   dashboard mounts the *directory*, so the rename is visible in the
//   container; a single-file bind mount would keep the old inode.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HelpText = `Usage: claude-statusline.mjs [--help]

Claude Code status line command. Reads the status line JSON from stdin, saves
its rate_limits (the numbers behind /usage) to a state file for usage-dashboard,
and prints a compact status line such as:
  Opus 5.5 · 5h 34% (resets 13:00) · wk 41% (Fri 19:00)

Install with: node scripts/install-statusline.mjs

Environment:
  USAGE_DASHBOARD_STATE_FILE        State file path
                                    (default ~/.claude/usage-dashboard/rate-limits.json)
  USAGE_DASHBOARD_STATUSLINE_CHAIN  Optional shell command to run with the same
                                    stdin; its output is printed instead of ours
                                    (keeps an existing status line). When unset,
                                    statusline-chain.json next to the state file
                                    (written by install-statusline.mjs --force) is used.
`;

export const MaxWindows = 16;
const WindowKeyPattern = /^[a-z0-9_]{1,40}$/i;
const ChainTimeoutMs = 2000;

export function defaultStateFile(environment = process.env) {
  if (environment.USAGE_DASHBOARD_STATE_FILE) return environment.USAGE_DASHBOARD_STATE_FILE;
  return path.join(environment.HOME || os.homedir(), '.claude', 'usage-dashboard', 'rate-limits.json');
}

function scalarOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 64);
  return null;
}

// Copies every window object under rate_limits (five_hour, seven_day,
// spend_limit and any future key), keeping only scalar fields. Returns null
// when nothing usable is present.
export function sanitizeRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object' || Array.isArray(rateLimits)) return null;
  const windows = {};
  let windowCount = 0;
  for (const [windowKey, windowValue] of Object.entries(rateLimits)) {
    if (windowCount >= MaxWindows) break;
    if (!WindowKeyPattern.test(windowKey) || !windowValue || typeof windowValue !== 'object' || Array.isArray(windowValue)) continue;
    const fields = {};
    for (const [fieldKey, fieldValue] of Object.entries(windowValue)) {
      if (!WindowKeyPattern.test(fieldKey)) continue;
      const scalar = scalarOrNull(fieldValue);
      if (scalar !== null) fields[fieldKey] = scalar;
    }
    if (typeof fields.used_percentage !== 'number') continue; // the one documented field every window has
    windows[windowKey] = fields;
    windowCount += 1;
  }
  return windowCount ? windows : null;
}

export function buildCapture(input, now = new Date()) {
  const rateLimits = sanitizeRateLimits(input?.rate_limits);
  if (!rateLimits) return null;
  const capture = { capturedAt: now.toISOString() };
  if (typeof input.session_id === 'string') capture.sessionId = input.session_id.slice(0, 64);
  const model = input.model && typeof input.model === 'object' ? input.model : null;
  if (model && (typeof model.id === 'string' || typeof model.display_name === 'string')) {
    capture.model = {};
    if (typeof model.id === 'string') capture.model.id = model.id.slice(0, 64);
    if (typeof model.display_name === 'string') capture.model.displayName = model.display_name.slice(0, 64);
  }
  capture.rate_limits = rateLimits;
  return capture;
}

export function writeStateAtomically(stateFile, capture) {
  const directory = path.dirname(stateFile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempFile = path.join(directory, `.${path.basename(stateFile)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(capture)}\n`, { mode: 0o600 });
    fs.renameSync(tempFile, stateFile);
  } catch (error) {
    try { fs.unlinkSync(tempFile); } catch { /* already gone */ }
    throw error;
  }
}

const pad2 = (value) => String(value).padStart(2, '0');
const WeekdayShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Local wall time: HH:MM when the reset is within 24 h, else "Fri 19:00".
export function formatReset(resetsAtSeconds, now = new Date()) {
  if (typeof resetsAtSeconds !== 'number' || !Number.isFinite(resetsAtSeconds)) return null;
  const resetDate = new Date(resetsAtSeconds * 1000);
  if (Number.isNaN(resetDate.getTime())) return null;
  const clock = `${pad2(resetDate.getHours())}:${pad2(resetDate.getMinutes())}`;
  return resetDate.getTime() - now.getTime() < 24 * 3600_000 ? clock : `${WeekdayShort[resetDate.getDay()]} ${clock}`;
}

const WindowLabels = { five_hour: '5h', seven_day: 'wk', spend_limit: 'spend' };

function formatPercent(value) {
  return `${Math.round(value)}%`;
}

export function formatStatusLine(input, now = new Date()) {
  const parts = [];
  const modelName = input?.model?.display_name || input?.model?.id;
  parts.push(typeof modelName === 'string' && modelName ? modelName.slice(0, 40) : 'Claude');
  const rateLimits = sanitizeRateLimits(input?.rate_limits);
  if (rateLimits) {
    const nowSeconds = now.getTime() / 1000;
    const orderedKeys = [...Object.keys(WindowLabels), ...Object.keys(rateLimits).filter((key) => !(key in WindowLabels))];
    for (const windowKey of orderedKeys) {
      const window = rateLimits[windowKey];
      if (!window) continue;
      if (typeof window.resets_at === 'number' && window.resets_at <= nowSeconds) continue;
      const label = WindowLabels[windowKey] || windowKey.replace(/_/g, ' ');
      const reset = formatReset(window.resets_at, now);
      const resetText = reset ? (windowKey === 'five_hour' ? ` (resets ${reset})` : ` (${reset})`) : '';
      parts.push(`${label} ${formatPercent(window.used_percentage)}${resetText}`);
    }
  } else {
    const contextPercent = input?.context_window?.used_percentage;
    if (typeof contextPercent === 'number' && Number.isFinite(contextPercent)) parts.push(`ctx ${formatPercent(contextPercent)}`);
  }
  return parts.join(' · ');
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function chainCommand(environment, stateFile) {
  if (environment.USAGE_DASHBOARD_STATUSLINE_CHAIN) return environment.USAGE_DASHBOARD_STATUSLINE_CHAIN;
  try {
    const chain = JSON.parse(fs.readFileSync(path.join(path.dirname(stateFile), 'statusline-chain.json'), 'utf8'));
    return typeof chain?.command === 'string' ? chain.command : '';
  } catch {
    return '';
  }
}

// Runs the previous status line with the same stdin. Its output wins when it
// succeeds; on failure, timeout or empty output we fall back to ours. A
// command pointing back at this script is ignored (no recursion).
function runChain(command, rawInput, environment) {
  if (!command || command.includes('claude-statusline.mjs')) return null;
  const childEnvironment = { ...environment };
  delete childEnvironment.USAGE_DASHBOARD_STATUSLINE_CHAIN;
  const result = spawnSync('/bin/sh', ['-c', command], {
    input: rawInput, encoding: 'utf8', timeout: ChainTimeoutMs, env: childEnvironment, stdio: ['pipe', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) return null;
  return result.stdout.replace(/\n+$/, '');
}

export function main({ argv = process.argv.slice(2), environment = process.env, rawInput, now = new Date(), write = (text) => process.stdout.write(text) } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    write(HelpText);
    return;
  }
  let line = 'Claude';
  let input = null;
  let stateFile = null;
  const raw = rawInput ?? readStdin();
  try {
    input = JSON.parse(raw);
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = null;
  } catch {
    input = null;
  }
  try {
    stateFile = defaultStateFile(environment);
    const capture = input ? buildCapture(input, now) : null;
    if (capture) writeStateAtomically(stateFile, capture);
  } catch {
    // Read-only home, full disk...: the status line must still render.
  }
  try {
    if (input) line = formatStatusLine(input, now);
  } catch {
    line = 'Claude';
  }
  try {
    const chained = runChain(chainCommand(environment, stateFile || defaultStateFile(environment)), raw, environment);
    if (chained != null) line = chained;
  } catch {
    // keep our line
  }
  write(`${line}\n`);
}

// Run only when executed directly, so tests can import the helpers.
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  try {
    main();
  } catch {
    try { process.stdout.write('Claude\n'); } catch { /* nothing left to do */ }
  }
}
