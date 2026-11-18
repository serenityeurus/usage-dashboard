#!/usr/bin/env node
// Installs (or removes) scripts/claude-statusline.mjs as Claude Code's status
// line in ~/.claude/settings.json.
//
// Safety rules:
// - Only the `statusLine` key is touched; every other key and its order are
//   preserved. Invalid JSON in settings.json aborts without writing.
// - A timestamped copy of settings.json goes to ~/backups/ before any write.
// - An existing statusLine that is not ours is left alone unless --force. With
//   --force it is recorded in the backup and in statusline-chain.json next to
//   the state file, so claude-statusline.mjs keeps rendering it (chaining) and
//   --uninstall can restore it.
// - The command uses absolute paths to this Node binary and the script, because
//   Claude Code runs it through a non-login shell where nvm's `node` may not be
//   on PATH. Re-run the installer after switching Node versions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HelpText = `Usage: install-statusline.mjs [--dry-run] [--force] [--uninstall] [--help]

Adds usage-dashboard's status line to Claude Code's user settings
(~/.claude/settings.json, or $CLAUDE_CONFIG_DIR/settings.json), so interactive
Claude Code sessions save their /usage rate limits for the dashboard.

  --dry-run    Show what would change; write nothing.
  --force      Replace an existing, different statusLine. It is backed up and
               chained: its output is still shown in Claude Code.
  --uninstall  Remove our statusLine (restoring a chained one, if any).
  --help       This text.

A backup of settings.json is written to ~/backups/ before every change.
Environment: USAGE_DASHBOARD_STATE_FILE (state file path), CLAUDE_CONFIG_DIR.
`;

const ScriptMarker = 'claude-statusline.mjs';

function shellQuote(value) {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function resolvePaths(environment = process.env) {
  const homeDir = environment.HOME || os.homedir();
  const configDir = environment.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
  const stateFile = environment.USAGE_DASHBOARD_STATE_FILE || path.join(homeDir, '.claude', 'usage-dashboard', 'rate-limits.json');
  return {
    settingsFile: path.join(configDir, 'settings.json'),
    backupDir: path.join(homeDir, 'backups'),
    stateDir: path.dirname(stateFile),
    chainFile: path.join(path.dirname(stateFile), 'statusline-chain.json'),
  };
}

export function statusLineCommand({ nodePath = process.execPath, scriptPath } = {}) {
  const resolvedScript = scriptPath || path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-statusline.mjs');
  return `${shellQuote(nodePath)} ${shellQuote(resolvedScript)}`;
}

export const isOurStatusLine = (statusLine) => typeof statusLine?.command === 'string' && statusLine.command.includes(ScriptMarker);

function readSettings(settingsFile) {
  let text;
  try {
    text = fs.readFileSync(settingsFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, settings: {}, text: null };
    throw error;
  }
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    throw new Error(`${settingsFile} is not valid JSON (${error.message}); fix it first, nothing was changed`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${settingsFile} does not contain a JSON object; nothing was changed`);
  }
  return { exists: true, settings, text };
}

function writeAtomically(filePath, text, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, text, { mode });
  fs.renameSync(tempFile, filePath);
}

const timestampSlug = (now) => now.toISOString().replace(/[:.]/g, '-');

// Pure planning step: what the new settings and side files should be.
// Returns { action, changed, message, settings, chain, removeChain }.
export function planChange({ settings, chain, command, uninstall = false, force = false }) {
  const current = settings.statusLine;
  if (uninstall) {
    if (current === undefined) {
      return { action: 'none', changed: false, message: 'No statusLine is set; nothing to uninstall.', removeChain: Boolean(chain) };
    }
    if (!isOurStatusLine(current) && !force) {
      return { action: 'refuse', changed: false, message: 'The statusLine is not usage-dashboard\'s; leaving it (use --force to remove it anyway).' };
    }
    const next = { ...settings };
    if (chain?.statusLine) next.statusLine = chain.statusLine;
    else delete next.statusLine;
    return {
      action: 'uninstall', changed: true, settings: next, removeChain: true,
      message: chain?.statusLine ? 'Removed usage-dashboard\'s statusLine and restored the previous one.' : 'Removed usage-dashboard\'s statusLine.',
    };
  }
  const desired = { type: 'command', command };
  if (isOurStatusLine(current)) {
    // Keep user tweaks such as padding/refreshInterval; only the command is ours.
    if (current.type === 'command' && current.command === command) {
      return { action: 'none', changed: false, message: 'Already installed; nothing to do.' };
    }
    return { action: 'update', changed: true, settings: { ...settings, statusLine: { ...current, ...desired } }, message: 'Updated usage-dashboard\'s statusLine command.' };
  }
  if (current !== undefined && !force) {
    return {
      action: 'refuse', changed: false,
      message: `A different statusLine is already set (${JSON.stringify(current)}). Re-run with --force to replace it; `
        + 'it will be backed up and chained so its output still shows.',
    };
  }
  const result = { action: current === undefined ? 'install' : 'replace', changed: true, settings: { ...settings, statusLine: desired } };
  if (current !== undefined) {
    const previousCommand = current?.type === 'command' && typeof current.command === 'string' ? current.command : null;
    result.chain = { statusLine: current, command: previousCommand };
    result.message = previousCommand
      ? 'Replaced the existing statusLine; its command is chained so its output still shows.'
      : 'Replaced the existing statusLine (not a command, so it cannot be chained; it is in the backup).';
  } else {
    result.message = 'Installed usage-dashboard\'s statusLine.';
  }
  return result;
}

// Top-level keys, with the statusLine value, for a secret-free before/after view.
export function describeSettings(settings) {
  return Object.keys(settings).map((key) => (key === 'statusLine' ? `statusLine=${JSON.stringify(settings[key])}` : key));
}

export function run({ argv = process.argv.slice(2), environment = process.env, now = new Date(), log = console.log, command } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    log(HelpText.trimEnd());
    return 0;
  }
  const knownFlags = new Set(['--dry-run', '--force', '--uninstall']);
  const unknown = argv.filter((arg) => !knownFlags.has(arg));
  if (unknown.length) {
    log(`Unknown argument(s): ${unknown.join(' ')}\n\n${HelpText.trimEnd()}`);
    return 2;
  }
  const dryRun = argv.includes('--dry-run');
  const paths = resolvePaths(environment);
  const { exists, settings, text } = readSettings(paths.settingsFile);
  let chain = null;
  try {
    chain = JSON.parse(fs.readFileSync(paths.chainFile, 'utf8'));
  } catch { /* no chain recorded */ }
  const plan = planChange({
    settings, chain, command: command || statusLineCommand(), uninstall: argv.includes('--uninstall'), force: argv.includes('--force'),
  });

  log(`${dryRun ? '[dry run] ' : ''}${plan.message}`);
  log(`settings: ${paths.settingsFile}`);
  if (!plan.changed) {
    if (plan.removeChain && !dryRun) fs.rmSync(paths.chainFile, { force: true });
    return plan.action === 'refuse' ? 1 : 0;
  }
  log(`before keys: ${describeSettings(settings).join(', ') || '(none)'}`);
  log(`after keys:  ${describeSettings(plan.settings).join(', ') || '(none)'}`);
  if (dryRun) return 0;

  if (exists) {
    fs.mkdirSync(paths.backupDir, { recursive: true });
    const backupFile = path.join(paths.backupDir, `settings-claude-${timestampSlug(now)}.json`);
    // The backup embeds the replaced statusLine (if any) as part of the original file.
    fs.writeFileSync(backupFile, text, { mode: 0o600, flag: 'wx' });
    log(`backup: ${backupFile}`);
  } else {
    log('backup: none (settings.json did not exist)');
  }
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 }); // so the dashboard's directory mount exists
  if (plan.chain) writeAtomically(paths.chainFile, `${JSON.stringify(plan.chain, null, 2)}\n`, 0o600);
  if (plan.removeChain) fs.rmSync(paths.chainFile, { force: true });
  const mode = exists ? fs.statSync(paths.settingsFile).mode & 0o777 : 0o600;
  writeAtomically(paths.settingsFile, `${JSON.stringify(plan.settings, null, 2)}\n`, mode);
  return 0;
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`install-statusline: ${error.message}`);
    process.exitCode = 1;
  }
}
