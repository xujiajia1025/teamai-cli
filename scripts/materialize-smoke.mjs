import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { builtinModules } from 'node:module';
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

function invokeInformational(entry, args, home, expectedStdout) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: path.join(sandbox, 'no-external-tools'),
    },
    input: '',
  });
  assert.equal(result.status, 0, `informational command failed: ${result.stderr}`);
  assert.equal(result.stdout, expectedStdout);
  assert.equal(result.stderr, '');
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
  const standaloneBytes = await fs.readFile(standalonePath);
  const standaloneBundle = standaloneBytes.toString('utf8');
  const metafile = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'dist', 'metafile-esm.json'), 'utf8'));
  const artifactMetadata = metafile.outputs['dist/materialize-bin.js'];
  assert.equal(artifactMetadata.entryPoint, 'src/materialize-bin.ts');
  // tsup appends the source-map reference after esbuild records output bytes.
  assert.equal(artifactMetadata.bytes <= standaloneBytes.byteLength, true);
  assert.equal(standaloneBytes.byteLength - artifactMetadata.bytes < 256, true);
  const unexpectedInputs = Object.keys(metafile.inputs).filter((input) => (
    !/^src\/materialize(?:-bin|-cmd|\/).*\.ts$/.test(input)
    && !/^node_modules\/zod\//.test(input)
  ));
  assert.deepEqual(unexpectedInputs, [], `standalone artifact has unexpected inputs: ${unexpectedInputs.join(', ')}`);
  const externalImports = [
    ...standaloneBundle.matchAll(/^import\s+.*?\s+from\s*["']([^"']+)["'];?$/gm),
    ...standaloneBundle.matchAll(/^import\s*["']([^"']+)["'];?$/gm),
  ].map((match) => match[1]);
  const externalRequires = [...standaloneBundle.matchAll(/\b(?:require|__require)\(\s*["']([^"']+)["']\s*\)/g)]
    .map((match) => match[1]);
  const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
  const forbiddenBuiltins = new Set([
    'child_process', 'cluster', 'dgram', 'dns', 'http', 'http2', 'https', 'net',
    'tls', 'worker_threads',
  ]);
  const metafileImports = artifactMetadata.imports
    .filter((dependency) => dependency.external)
    .map((dependency) => dependency.path);
  assert.deepEqual(
    [...new Set(
      [...externalImports, ...externalRequires, ...metafileImports]
        .filter((name) => !nodeBuiltins.has(name.replace(/^node:/, ''))),
    )],
    [],
    `standalone artifact has non-builtin imports: ${[...externalImports, ...externalRequires, ...metafileImports].join(', ')}`,
  );
  assert.deepEqual(
    metafileImports.filter((name) => forbiddenBuiltins.has(name.replace(/^node:/, ''))),
    [],
    `standalone artifact imports forbidden Node capabilities: ${metafileImports.join(', ')}`,
  );
  assert.equal(/(?:from|import\s*)\s*["'](?:commander|zod)["']/.test(standaloneBundle), false);
  assert.equal(/(?:process\.env\.(?:HOME|USERPROFILE)|\.teamai|teamai\.yaml|child_process|simple-git|\bfetch\s*\(|\bWebSocket\b|\bWorker\b|from ["'](?:net|http|https|tls|dns|dgram|worker_threads)["'])/.test(standaloneBundle), false);
  assert.equal(standaloneBundle.includes('Copyright (C) 2026 Tencent.'), true);
  assert.equal(standaloneBundle.includes('Copyright (c) 2025 Colin McDonnell'), true);

  // Run a byte-for-byte copy outside the repository/package and away from node_modules.
  // The .mjs suffix preserves the artifact's ESM classification without package metadata.
  const isolatedArtifact = path.join(sandbox, 'artifact', 'teamai-materialize.mjs');
  await fs.mkdir(path.dirname(isolatedArtifact));
  await fs.writeFile(isolatedArtifact, standaloneBytes, { mode: 0o755 });
  await fs.chmod(isolatedArtifact, 0o755);

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
    'THIRD_PARTY_NOTICES.materialize.txt',
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
  const zodPackage = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'node_modules', 'zod', 'package.json'), 'utf8'));
  const thirdPartyNotices = await fs.readFile(
    path.join(repositoryRoot, 'THIRD_PARTY_NOTICES.materialize.txt'),
    'utf8',
  );
  assert.equal(thirdPartyNotices.includes(`Zod ${zodPackage.version}`), true);
  assert.equal(standaloneBundle.includes(thirdPartyNotices.trimEnd()), true);

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
      isolatedArtifact,
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
  invokeInformational(isolatedArtifact, ['--version'], home, `${packageJson.version}\n`);
  invokeInvalid(isolatedArtifact, [], home);
  assert.deepEqual(await fs.readdir(home), []);
  console.log(`TeamAI materialize built-CLI smoke passed (sha256: ${sha256(standaloneBytes)}).`);
} finally {
  await fs.rm(sandbox, { recursive: true, force: true });
}
