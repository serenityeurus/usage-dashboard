import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planChange, run, statusLineCommand } from '../scripts/install-statusline.mjs';

const InstallerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install-statusline.mjs');
const OurCommand = '/opt/node/bin/node /repo/scripts/claude-statusline.mjs';

function makeHome(settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ud-install-'));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), typeof settings === 'string' ? settings : `${JSON.stringify(settings, null, 2)}\n`);
  }
  return home;
}

const readSettings = (home) => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
const backups = (home) => (fs.existsSync(path.join(home, 'backups')) ? fs.readdirSync(path.join(home, 'backups')) : []);

function install(home, argv = [], now = new Date('2026-11-17T12:00:00Z')) {
  const lines = [];
  const code = run({ argv, environment: { HOME: home }, now, log: (line) => lines.push(line), command: OurCommand });
  return { code, output: lines.join('\n') };
}

describe('install-statusline.mjs', () => {
  it('merges statusLine, preserves every other key and order, backs up first, creates the state dir', () => {
    const home = makeHome({ model: 'opus', theme: 'dark', env: { FOO: '1' } });
    const original = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    const { code, output } = install(home);
    assert.equal(code, 0);
    const settings = readSettings(home);
    assert.deepEqual(Object.keys(settings), ['model', 'theme', 'env', 'statusLine']);
    assert.deepEqual(settings.statusLine, { type: 'command', command: OurCommand });
    assert.deepEqual(settings.env, { FOO: '1' });
    assert.deepEqual(backups(home), ['settings-claude-2026-11-17T12-00-00-000Z.json']);
    assert.equal(fs.readFileSync(path.join(home, 'backups', backups(home)[0]), 'utf8'), original);
    assert.ok(fs.statSync(path.join(home, '.claude', 'usage-dashboard')).isDirectory());
    assert.match(output, /before keys: model, theme, env\nafter keys:  model, theme, env, statusLine=/);
  });

  it('is idempotent: a second run changes nothing and writes no backup', () => {
    const home = makeHome({ model: 'opus' });
    install(home);
    const { code, output } = install(home, [], new Date('2026-11-17T13:00:00Z'));
    assert.equal(code, 0);
    assert.match(output, /Already installed/);
    assert.equal(backups(home).length, 1);
  });

  it('updates our own command (e.g. a new Node path) but keeps user tweaks like padding', () => {
    const home = makeHome({ statusLine: { type: 'command', command: '/old/node /repo/scripts/claude-statusline.mjs', padding: 2 } });
    install(home);
    assert.deepEqual(readSettings(home).statusLine, { type: 'command', command: OurCommand, padding: 2 });
  });

  it('--dry-run writes nothing', () => {
    const home = makeHome({ model: 'opus' });
    const before = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    const { code, output } = install(home, ['--dry-run']);
    assert.equal(code, 0);
    assert.match(output, /^\[dry run\] Installed/);
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), before);
    assert.deepEqual(backups(home), []);
    assert.equal(fs.existsSync(path.join(home, '.claude', 'usage-dashboard')), false);
  });

  it('refuses to replace a different statusLine without --force', () => {
    const home = makeHome({ statusLine: { type: 'command', command: '~/.claude/statusline.sh' } });
    const { code, output } = install(home);
    assert.equal(code, 1);
    assert.match(output, /--force/);
    assert.equal(readSettings(home).statusLine.command, '~/.claude/statusline.sh');
    assert.deepEqual(backups(home), []);
  });

  it('--force replaces it, keeps it in the backup and chains it; --uninstall restores it', () => {
    const previous = { type: 'command', command: '~/.claude/statusline.sh', padding: 1 };
    const home = makeHome({ model: 'opus', statusLine: previous });
    assert.equal(install(home, ['--force']).code, 0);
    assert.equal(readSettings(home).statusLine.command, OurCommand);
    const backup = JSON.parse(fs.readFileSync(path.join(home, 'backups', backups(home)[0]), 'utf8'));
    assert.deepEqual(backup.statusLine, previous);
    const chainFile = path.join(home, '.claude', 'usage-dashboard', 'statusline-chain.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(chainFile, 'utf8')), { statusLine: previous, command: previous.command });

    const { code, output } = install(home, ['--uninstall'], new Date('2026-11-17T14:00:00Z'));
    assert.equal(code, 0);
    assert.match(output, /restored the previous one/);
    assert.deepEqual(readSettings(home), { model: 'opus', statusLine: previous });
    assert.equal(fs.existsSync(chainFile), false);
    assert.equal(backups(home).length, 2, 'uninstall backs up too');
  });

  it('--uninstall removes only our statusLine and refuses a foreign one', () => {
    const home = makeHome({ model: 'opus', theme: 'dark' });
    install(home);
    assert.equal(install(home, ['--uninstall'], new Date('2026-11-17T15:00:00Z')).code, 0);
    assert.deepEqual(readSettings(home), { model: 'opus', theme: 'dark' });
    assert.match(install(home, ['--uninstall']).output, /nothing to uninstall/);
    const foreign = makeHome({ statusLine: { type: 'command', command: 'other' } });
    assert.equal(install(foreign, ['--uninstall']).code, 1);
    assert.equal(readSettings(foreign).statusLine.command, 'other');
  });

  it('creates settings.json when missing (no backup needed) and refuses invalid JSON', () => {
    const empty = makeHome();
    assert.equal(install(empty).code, 0);
    assert.deepEqual(readSettings(empty), { statusLine: { type: 'command', command: OurCommand } });
    assert.match(install(empty).output, /Already installed/);
    const broken = makeHome('{"model": "opus",');
    assert.throws(() => install(broken), /not valid JSON/);
    assert.equal(fs.readFileSync(path.join(broken, '.claude', 'settings.json'), 'utf8'), '{"model": "opus",');
  });

  it('builds an absolute, shell-quoted command', () => {
    assert.equal(statusLineCommand({ nodePath: '/usr/bin/node', scriptPath: '/a b/claude-statusline.mjs' }), "/usr/bin/node '/a b/claude-statusline.mjs'");
    assert.match(statusLineCommand(), /^\/\S+node\S* \/\S+\/scripts\/claude-statusline\.mjs$/);
  });

  it('plans a non-command statusLine replacement without a chain command', () => {
    const plan = planChange({ settings: { statusLine: { type: 'weird' } }, command: OurCommand, force: true });
    assert.equal(plan.chain.command, null);
  });

  it('--help and unknown flags (CLI)', () => {
    const help = spawnSync(process.execPath, [InstallerPath, '--help'], { encoding: 'utf8', env: { HOME: makeHome() } });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--dry-run/);
    const bad = spawnSync(process.execPath, [InstallerPath, '--bogus'], { encoding: 'utf8', env: { HOME: makeHome() } });
    assert.equal(bad.status, 2);
  });
});
