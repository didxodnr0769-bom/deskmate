import test from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

interface SourceArchiveModule {
  stageSourceArchive(options: { root: string; destination: string; entries?: readonly string[] }): Promise<string[]>;
}
// The helper is used by Node directly; a URL import avoids an untyped static .mjs declaration.
const { stageSourceArchive } = await import(new URL('../scripts/source-archive.mjs', import.meta.url).href) as SourceArchiveModule;

const sharedFiles = [
  'docs/architecture.md', 'docs/character-guide.md', 'docs/agent-provider-guide.md',
  'docs/chelsea-gait.md',
  'docs/verification.md', '.agents/README.md', 'AGENTS.md', 'CLAUDE.md', 'README.md',
  'package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  '.gitignore', '.nvmrc', 'tsconfig.json', 'vite.config.ts', 'index.html',
  'docs/usage.md', 'docs/assets.md', 'docs/security.md', 'docs/customization.md',
  'docs/images/companion.png', 'docs/images/memos.png', 'docs/images/chat.png', 'docs/images/settings.png',
];
const codeFiles = [
  'src/main/bootstrap.ts', 'src/renderer/assets/character.png', 'src/shared/authorization.ts',
  'tests/domain/schedule.test.ts', 'scripts/build.mjs', 'scripts/source-archive.mjs',
];

async function write(root: string, path: string, content = `shared input: ${path}`) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'deskmate-source-'));
  const root = join(base, 'project');
  const destination = join(base, 'staging', 'nested', 'deskmate');
  await mkdir(root);
  for (const file of [...sharedFiles, ...codeFiles]) await write(root, file);
  return { base, root, destination };
}

async function files(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.equal(entry.isSymbolicLink(), false, `staging must not contain a symbolic link: ${path}`);
    if (entry.isDirectory()) result.push(...await files(join(root, entry.name), path));
    else result.push(path);
  }
  return result.sort();
}

test('source staging preserves shared AI guides and nested code while excluding local and private inputs', async t => {
  const { base, root, destination } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  // Empty Git rules prove packaging does not delegate its inclusion policy to Git.
  await write(root, '.gitignore', '');
  const privateFiles = [
    'docs/personal-notes.md', 'docs/plans/session.md', '.agents/notes/private.md',
    'docs/images/private-screen.png', 'docs/images/session-private.png',
    '.codex/config.toml', '.claude/settings.json', '.cursor/rules/private.mdc',
    'src/.codex/config.toml', 'src/.claude/settings.json', 'src/.cursor/rules/private.mdc',
    'tests/.vscode/settings.json', 'scripts/.idea/workspace.xml', 'src/.agents/README.md',
    'src/.aws/credentials', 'scripts/.local/session.json',
    'src/config/.env', 'src/config/.env.local', 'src/config/.npmrc', 'src/config/.netrc',
    'src/config/credentials.json', 'src/config/service-account.json', 'src/config/oauth-token.json',
    'src/config/secrets.production.yaml', 'src/config/auth.json', 'src/config/id_rsa',
    'src/config/id_ed25519.pub', 'src/config/client.pem', 'src/config/client.key',
    'src/config/signing.p12', 'src/config/profile.mobileprovision',
    'src/config/settings.local.json', 'scripts/config.local.toml',
    'src/config/signing.p8', 'src/config/signing.jks', 'src/config/signing.keystore',
    'src/data/memos.json', 'src/data/memos.v2.backup.json', 'src/data/worktime.json', 'src/data/briefing.json', 'src/data/briefing.json.backup', 'src/data/appearance.json', 'src/data/appearance.json.backup',
    'src/data/worktime.json.tmp', 'src/data/memos-personal.json', 'src/data/worktime.v2.backup.json',
    'src/userData/cache.json', 'src/.local-data/private.json',
    'tests/qa-results/screenshot.png', 'tests/logs/session.json', 'tests/captures/private.png',
    'scripts/private.log', 'scripts/work/private.txt', 'scripts/outputs/private.txt',
    'scripts/.cursorrules', 'scripts/CLAUDE.local.md', 'scripts/personal.code-workspace',
  ];
  for (const file of privateFiles) await write(root, file, 'PRIVATE FIXTURE');

  const copied = await stageSourceArchive({ root, destination });
  const expected = [...sharedFiles, ...codeFiles].sort();
  assert.deepEqual(await files(destination), expected);
  assert.deepEqual(copied, expected);
  for (const file of expected) {
    assert.deepEqual(await readFile(join(destination, file)), await readFile(join(root, file)));
  }
  for (const file of privateFiles) assert.equal(await readFile(join(root, file), 'utf8'), 'PRIVATE FIXTURE');
});

test('source staging never follows external file or directory links', async t => {
  const { base, root, destination } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const outside = join(base, 'outside');
  await write(outside, 'private.txt', 'EXTERNAL PRIVATE FIXTURE');
  await symlink(join(outside, 'private.txt'), join(root, 'src', 'linked.ts'));
  await symlink(outside, join(root, 'tests', 'linked-directory'));
  await symlink(join(base, 'missing'), join(root, 'scripts', 'broken-link'));
  await stageSourceArchive({ root, destination });
  assert.deepEqual(await files(destination), [...sharedFiles, ...codeFiles].sort());
  assert.equal((await lstat(join(root, 'src', 'linked.ts'))).isSymbolicLink(), true);
  assert.equal(await readFile(join(outside, 'private.txt'), 'utf8'), 'EXTERNAL PRIVATE FIXTURE');
});

test('missing required source inputs fail before creating a stage', async t => {
  const { base, root, destination } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  await rm(join(root, 'docs', 'verification.md'));
  await assert.rejects(stageSourceArchive({ root, destination }), { code: 'ENOENT' });
  await assert.rejects(access(destination), { code: 'ENOENT' });
});

test('unreviewed, traversal and duplicate source selections are rejected', async t => {
  const { base, root, destination } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const entries of [[], ['docs'], ['.agents'], ['../outside'], ['/tmp/outside'], ['src', 'src'], ['src/../README.md']]) {
    await assert.rejects(stageSourceArchive({ root, destination, entries }), /reviewed project inputs/);
  }
  await assert.rejects(access(destination), { code: 'ENOENT' });
});

test('required input types and linked shared-guide parents are rejected', async t => {
  const { base, root, destination } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  await rm(join(root, '.agents'), { recursive: true });
  const outside = join(base, 'private-agents');
  await write(outside, 'README.md', 'PRIVATE AGENT SETTINGS');
  await symlink(outside, join(root, '.agents'));
  await assert.rejects(stageSourceArchive({ root, destination }), /invalid type/);
  await rm(join(root, '.agents'));
  await write(root, '.agents/README.md');
  await rm(join(root, 'README.md'));
  await mkdir(join(root, 'README.md'));
  await assert.rejects(stageSourceArchive({ root, destination }), /invalid type/);
  await assert.rejects(access(destination), { code: 'ENOENT' });
});

test('an existing stage is rejected so stale private files cannot enter a new archive', async t => {
  const { base, root, destination } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  await write(destination, 'stale-private.txt', 'STALE PRIVATE FIXTURE');
  await assert.rejects(stageSourceArchive({ root, destination }), { code: 'EEXIST' });
  assert.deepEqual(await files(destination), ['stale-private.txt']);
});

test('overlapping destinations cannot overwrite or recursively include source inputs', async t => {
  const { base, root } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const destination of [root, base, join(root, 'src', 'stage'), join(root, 'tests', 'stage'), join(root, 'scripts', 'stage')]) {
    await assert.rejects(stageSourceArchive({ root, destination }), /overlap source inputs/);
  }
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'shared input: README.md');
});

test('a linked source root is rejected instead of staging another project', async t => {
  const { base, root, destination } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const linkedRoot = join(base, 'linked-project');
  await symlink(root, linkedRoot);
  await assert.rejects(stageSourceArchive({ root: linkedRoot, destination }), /real project directory/);
  await assert.rejects(access(destination), { code: 'ENOENT' });
});
