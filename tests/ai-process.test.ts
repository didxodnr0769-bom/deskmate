import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../src/main/ai/process';
import { AgentError } from '../src/main/ai/provider';

const base = () => ({ executable: process.execPath, cwd: tmpdir(), env: process.env, signal: new AbortController().signal, timeoutMs: 3000 });
const isCode = (code: string) => (error: unknown) => error instanceof AgentError && error.code === code;

test('runner passes stdin and literal argv without a command shell, preserving UTF-8 and exit status', async () => {
  const literal = '$(echo must-not-run); && > /tmp/unused-fixture';
  const input = '질문과 이모지 🪨';
  const output = await runProcess({ ...base(), args: ['-e',
    'process.stdin.setEncoding("utf8"); let s=""; process.stdin.on("data", x => s += x); process.stdin.on("end", () => { process.stdout.write(JSON.stringify([process.argv[1],s])); process.stderr.write("diagnostic"); process.exitCode=7; });',
    literal], input });
  assert.deepEqual(JSON.parse(output.stdout), [literal, input]);
  assert.equal(output.stderr, 'diagnostic');
  assert.equal(output.exitCode, 7);
});

test('pre-aborted and missing executable calls return typed sanitized errors', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runProcess({ ...base(), signal: controller.signal, args: ['-e', 'throw Error("must not start")'] }), isCode('cancelled'));
  await assert.rejects(runProcess({ ...base(), executable: '/missing/deskmate-codex-fixture', args: [] }), isCode('not-installed'));
});

test('runner enforces a combined output limit and a timeout even when TERM is ignored', async () => {
  await assert.rejects(runProcess({ ...base(), args: ['-e', 'process.stdout.write("x".repeat(4096)); setInterval(() => {},1000);'], maxOutputBytes: 100 }), isCode('failed'));
  const started = Date.now();
  await assert.rejects(runProcess({ ...base(), args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {},1000);'], timeoutMs: 100 }), isCode('timeout'));
  assert.ok(Date.now() - started < 2000);
});

test('active cancellation kills child process group before a descendant can write data', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deskmate-process-'));
  const marker = join(directory, 'should-not-exist');
  const ready = join(directory, 'ready');
  const controller = new AbortController();
  try {
    const descendant = 'process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "bad"),900); setInterval(()=>{},1000);';
    const parent = 'const {spawn}=require("node:child_process"); spawn(process.execPath,["-e",process.argv[1],process.argv[2]],{stdio:"ignore"}); require("node:fs").writeFileSync(process.argv[3],"ready"); process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000);';
    const pending = runProcess({ ...base(), signal: controller.signal, args: ['-e', parent, descendant, marker, ready] });
    for (let i = 0; i < 100; i++) {
      try { await readFile(ready); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    await access(ready);
    controller.abort();
    await assert.rejects(pending, isCode('cancelled'));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await assert.rejects(access(marker));
  } finally { controller.abort(); await rm(directory, { recursive: true, force: true }); }
});
