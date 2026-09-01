import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-materialize-smoke-')));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function prepareFixture() {
  const inputRoot = path.join(sandbox, 'input');
  const skillRoot = path.join(inputRoot, 'example');
  const skill = Buffer.from('# Materialize smoke\n');
  const script = Buffer.from('#!/bin/sh\necho smoke\n');
  await fs.mkdir(path.join(skillRoot, 'bin'), { recursive: true });
  await fs.writeFile(path.join(skillRoot, 'SKILL.md'), skill, { mode: 0o644 });
  await fs.writeFile(path.join(skillRoot, 'bin', 'run.sh'), script, { mode: 0o755 });
  await fs.chmod(path.join(skillRoot, 'SKILL.md'), 0o644);
  await fs.chmod(path.join(skillRoot, 'bin', 'run.sh'), 0o755);
  const request = {
    schema: 'teamai.materialize.request/v1',
    operation: 'copy-skills',
    target: { id: 'codex', layout: 'flat-skill-root/v1' },
    skills: [{
      id: 'example',
      files: [
        { path: 'SKILL.md', sha256: sha256(skill), size: skill.byteLength, mode: '0644' },
        { path: 'bin/run.sh', sha256: sha256(script), size: script.byteLength, mode: '0755' },
      ],
    }],
  };
  const requestPath = path.join(sandbox, 'request.json');
  await fs.writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
  return { inputRoot, requestPath, skill, script };
}

function invoke(entry, args, home) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: path.join(sandbox, 'no-external-tools'),
      HTTP_PROXY: 'http://127.0.0.1:1',
      HTTPS_PROXY: 'http://127.0.0.1:1',
      NO_PROXY: '',
    },
    input: '',
  });
  assert.equal(result.status, 0, `materialize failed: ${result.stderr}`);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
}

function invokeInvalid(entry, args, home) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: path.join(sandbox, 'no-external-tools'),
      HTTP_PROXY: 'http://127.0.0.1:1',
      HTTPS_PROXY: 'http://127.0.0.1:1',
      NO_PROXY: '',
    },
    input: '',
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.endsWith('\n'), true);
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    error: {
      code: 'MATERIALIZE_INVALID_REQUEST',
      message: 'Invalid materialize CLI arguments',
    },
    schema: 'teamai.materialize.result/v1',
    status: 'failed',
  });
}

async function assertOutput(outputRoot, resultPath, fixture) {
  assert.deepEqual(await fs.readFile(path.join(outputRoot, 'example', 'SKILL.md')), fixture.skill);
  assert.deepEqual(await fs.readFile(path.join(outputRoot, 'example', 'bin', 'run.sh')), fixture.script);
  assert.equal((await fs.stat(path.join(outputRoot, 'example', 'SKILL.md'))).mode & 0o777, 0o644);
  assert.equal((await fs.stat(path.join(outputRoot, 'example', 'bin', 'run.sh'))).mode & 0o777, 0o755);
  assert.equal((await fs.stat(resultPath)).mode & 0o777, 0o600);
  const raw = await fs.readFile(resultPath, 'utf8');
  const result = JSON.parse(raw);
  assert.equal(result.schema, 'teamai.materialize.result/v1');
  assert.equal(result.status, 'succeeded');
  assert.equal(raw.includes(sandbox), false);
  return result;
}

try {
  const standalonePath = path.join(repositoryRoot, 'dist', 'materialize-bin.js');
  const standaloneBundle = await fs.readFile(standalonePath, 'utf8');
  const externalImports = [...standaloneBundle.matchAll(/^import .* from ["']([^"']+)["'];$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(
    [...new Set(externalImports)].sort(),
    ['buffer', 'commander', 'crypto', 'fs', 'module', 'path', 'zod'],
  );
  assert.equal(/(?:process\.env\.(?:HOME|USERPROFILE)|\.teamai|teamai\.yaml|child_process|simple-git|from ["'](?:net|http|https|tls|dns)["'])/.test(standaloneBundle), false);

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const pack = spawnSync(npmCommand, ['pack', '--json', '--dry-run'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: path.join(sandbox, 'npm-cache') },
  });
  assert.equal(pack.status, 0, `npm pack failed: ${pack.stderr}`);
  const [packageManifest] = JSON.parse(pack.stdout);
  const packedFiles = new Map(packageManifest.files.map((file) => [file.path, file]));
  for (const required of [
    'dist/index.js',
    'dist/materialize-bin.js',
    'docs/materialize-v1.md',
    'docs/materialize-v1.zh-CN.md',
  ]) {
    assert.equal(packedFiles.has(required), true, `npm package is missing ${required}`);
  }
  assert.equal(
    packedFiles.get('dist/materialize-bin.js').size,
    (await fs.stat(standalonePath)).size,
  );
  assert.notEqual(packedFiles.get('dist/materialize-bin.js').mode & 0o111, 0);
  const packageJson = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin['teamai-materialize'], 'dist/materialize-bin.js');

  const fixture = await prepareFixture();
  const home = path.join(sandbox, 'home');
  await fs.mkdir(home);
  const standaloneOutput = path.join(sandbox, 'standalone-output');
  const standaloneResult = path.join(sandbox, 'standalone-result.json');
  const common = [
    '--request', fixture.requestPath,
    '--input-root', fixture.inputRoot,
  ];
  const inheritedUmask = process.umask(0o777);
  try {
    invoke(
      path.join(repositoryRoot, 'dist', 'materialize-bin.js'),
      [...common, '--output-root', standaloneOutput, '--result', standaloneResult],
      home,
    );
  } finally {
    process.umask(inheritedUmask);
  }
  const first = await assertOutput(standaloneOutput, standaloneResult, fixture);

  const wrapperOutput = path.join(sandbox, 'wrapper-output');
  const wrapperResult = path.join(sandbox, 'wrapper-result.json');
  invoke(
    path.join(repositoryRoot, 'dist', 'index.js'),
    ['materialize', ...common, '--output-root', wrapperOutput, '--result', wrapperResult],
    home,
  );
  const second = await assertOutput(wrapperOutput, wrapperResult, fixture);
  assert.deepEqual(second, first);
  invokeInvalid(path.join(repositoryRoot, 'dist', 'materialize-bin.js'), [], home);
  assert.deepEqual(await fs.readdir(home), []);
  console.log('TeamAI materialize built-CLI smoke passed.');
} finally {
  await fs.rm(sandbox, { recursive: true, force: true });
}
