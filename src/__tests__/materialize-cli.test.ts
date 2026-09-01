import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMaterializeCli, type MaterializeCliOptions } from '../materialize-cmd.js';
import {
  MATERIALIZE_LAYOUT,
  MATERIALIZE_OPERATION,
  MATERIALIZE_REQUEST_SCHEMA,
  MATERIALIZE_RESULT_SCHEMA,
  type MaterializeRequest,
} from '../materialize/index.js';

class CapturedOutput extends Writable {
  readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding));
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

interface Fixture {
  options: MaterializeCliOptions;
  request: MaterializeRequest;
  skillBytes: Buffer;
}

let sandbox: string;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function createFixture(root = sandbox): Promise<Fixture> {
  const requestPath = path.join(root, 'request.json');
  const inputRoot = path.join(root, 'input');
  const outputRoot = path.join(root, 'output');
  const resultPath = path.join(root, 'result.json');
  const skillBytes = Buffer.from('# CLI fixture\n', 'utf8');
  const skillPath = path.join(inputRoot, 'example', 'SKILL.md');
  const request: MaterializeRequest = {
    schema: MATERIALIZE_REQUEST_SCHEMA,
    operation: MATERIALIZE_OPERATION,
    target: { id: 'codex', layout: MATERIALIZE_LAYOUT },
    skills: [{
      id: 'example',
      files: [{
        path: 'SKILL.md',
        sha256: sha256(skillBytes),
        size: skillBytes.byteLength,
        mode: '0644',
      }],
    }],
  };

  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, skillBytes, { mode: 0o644 });
  await fs.chmod(skillPath, 0o644);
  await fs.writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });

  return {
    options: { request: requestPath, inputRoot, outputRoot, result: resultPath },
    request,
    skillBytes,
  };
}

function parseDiagnostic(stderr: CapturedOutput): Record<string, unknown> {
  const text = stderr.text();
  expect(text.endsWith('\n')).toBe(true);
  expect(text.trim().split('\n')).toHaveLength(1);
  return JSON.parse(text) as Record<string, unknown>;
}

function expectNoAbsolutePathLeak(stderr: CapturedOutput, options: MaterializeCliOptions): void {
  const text = stderr.text();
  expect(text).not.toContain(sandbox);
  for (const candidate of Object.values(options)) {
    expect(text).not.toContain(path.resolve(candidate));
  }
}

beforeEach(async () => {
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-materialize-cli-')));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe('teamai-materialize CLI contract', () => {
  it('writes fresh deterministic output and result without using stdout', async () => {
    const fixture = await createFixture();
    const stderr = new CapturedOutput();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const exitCode = await runMaterializeCli(fixture.options, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe('');
    expect(stdout).not.toHaveBeenCalled();
    expect(await fs.readFile(
      path.join(fixture.options.outputRoot, 'example', 'SKILL.md'),
    )).toEqual(fixture.skillBytes);
    const result = JSON.parse(await fs.readFile(fixture.options.result, 'utf8')) as {
      schema: string;
      status: string;
      skills: unknown[];
    };
    expect(result).toMatchObject({
      schema: MATERIALIZE_RESULT_SCHEMA,
      status: 'succeeded',
      skills: fixture.request.skills,
    });
    expect((await fs.stat(fixture.options.result)).mode & 0o777).toBe(0o600);
  });

  it('enforces the strict request schema and writes a failed result with exit code 2', async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.options.request, JSON.stringify({
      ...fixture.request,
      undeclared: true,
    }));
    const stderr = new CapturedOutput();

    const exitCode = await runMaterializeCli(fixture.options, stderr);

    expect(exitCode).toBe(2);
    expect(await pathExists(fixture.options.outputRoot)).toBe(false);
    const failure = JSON.parse(await fs.readFile(fixture.options.result, 'utf8')) as Record<string, unknown>;
    expect(failure).toEqual({
      error: {
        code: 'MATERIALIZE_INVALID_REQUEST',
        message: 'Materialize request does not conform to v1',
      },
      schema: MATERIALIZE_RESULT_SCHEMA,
      status: 'failed',
    });
    expect(parseDiagnostic(stderr)).toEqual(failure);
    expectNoAbsolutePathLeak(stderr, fixture.options);
  });

  it('does not overwrite an existing output root', async () => {
    const fixture = await createFixture();
    const sentinel = path.join(fixture.options.outputRoot, 'sentinel');
    await fs.mkdir(fixture.options.outputRoot);
    await fs.writeFile(sentinel, 'keep-output');
    const stderr = new CapturedOutput();

    const exitCode = await runMaterializeCli(fixture.options, stderr);

    expect(exitCode).toBe(4);
    expect(await fs.readFile(sentinel, 'utf8')).toBe('keep-output');
    expect(await fs.readdir(fixture.options.outputRoot)).toEqual(['sentinel']);
    expect(await pathExists(fixture.options.result)).toBe(false);
    expect(parseDiagnostic(stderr)).toMatchObject({
      error: { code: 'MATERIALIZE_OUTPUT_EXISTS' },
      status: 'failed',
    });
    expectNoAbsolutePathLeak(stderr, fixture.options);
  });

  it('does not overwrite an existing result or create output', async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.options.result, 'keep-result');
    const stderr = new CapturedOutput();

    const exitCode = await runMaterializeCli(fixture.options, stderr);

    expect(exitCode).toBe(4);
    expect(await fs.readFile(fixture.options.result, 'utf8')).toBe('keep-result');
    expect(await pathExists(fixture.options.outputRoot)).toBe(false);
    expect(parseDiagnostic(stderr)).toMatchObject({
      error: { code: 'MATERIALIZE_OUTPUT_EXISTS' },
      status: 'failed',
    });
    expectNoAbsolutePathLeak(stderr, fixture.options);
  });

  it.runIf(process.platform !== 'win32')('rejects a symbolic-link request', async () => {
    const fixture = await createFixture();
    const realRequest = path.join(sandbox, 'real-request.json');
    await fs.rename(fixture.options.request, realRequest);
    await fs.symlink(path.basename(realRequest), fixture.options.request);
    const stderr = new CapturedOutput();

    const exitCode = await runMaterializeCli(fixture.options, stderr);

    expect(exitCode).toBe(2);
    expect(await pathExists(fixture.options.outputRoot)).toBe(false);
    expect(await pathExists(fixture.options.result)).toBe(false);
    expect(parseDiagnostic(stderr)).toMatchObject({
      error: { code: 'MATERIALIZE_UNSAFE_PATH' },
      status: 'failed',
    });
    expectNoAbsolutePathLeak(stderr, fixture.options);
  });

  it('rejects a hard-linked request and emits a failed result', async () => {
    const fixture = await createFixture();
    const realRequest = path.join(sandbox, 'real-request.json');
    await fs.rename(fixture.options.request, realRequest);
    await fs.link(realRequest, fixture.options.request);
    const stderr = new CapturedOutput();

    const exitCode = await runMaterializeCli(fixture.options, stderr);

    expect(exitCode).toBe(2);
    expect(await pathExists(fixture.options.outputRoot)).toBe(false);
    const failure = JSON.parse(await fs.readFile(fixture.options.result, 'utf8')) as Record<string, unknown>;
    expect(failure).toMatchObject({
      error: { code: 'MATERIALIZE_UNSAFE_PATH' },
      status: 'failed',
    });
    expect(parseDiagnostic(stderr)).toEqual(failure);
    expectNoAbsolutePathLeak(stderr, fixture.options);
  });

  it.each([
    ['request within input', (fixture: Fixture) => ({
      ...fixture.options,
      request: path.join(fixture.options.inputRoot, 'request.json'),
    })],
    ['output within input', (fixture: Fixture) => ({
      ...fixture.options,
      outputRoot: path.join(fixture.options.inputRoot, 'output'),
    })],
    ['result within input', (fixture: Fixture) => ({
      ...fixture.options,
      result: path.join(fixture.options.inputRoot, 'result.json'),
    })],
    ['output equal to result', (fixture: Fixture) => ({
      ...fixture.options,
      result: fixture.options.outputRoot,
    })],
  ] as const)('rejects overlapping topology: %s', async (_label, makeOptions) => {
    const fixture = await createFixture();
    const options = makeOptions(fixture);
    if (options.request !== fixture.options.request) {
      await fs.rename(fixture.options.request, options.request);
    }
    const stderr = new CapturedOutput();

    const exitCode = await runMaterializeCli(options, stderr);

    expect(exitCode).toBe(2);
    expect(parseDiagnostic(stderr)).toMatchObject({
      error: { code: 'MATERIALIZE_UNSAFE_PATH' },
      status: 'failed',
    });
    expectNoAbsolutePathLeak(stderr, options);
  });

  it('does not inspect or mutate HOME or unrelated CWD canaries', async () => {
    const cwdRoot = path.join(sandbox, 'cwd');
    const homeRoot = path.join(sandbox, 'home');
    await fs.mkdir(cwdRoot);
    await fs.mkdir(homeRoot);
    await fs.writeFile(path.join(cwdRoot, 'cwd-canary'), 'cwd-untouched');
    await fs.writeFile(path.join(homeRoot, 'home-canary'), 'home-untouched');
    const fixture = await createFixture(cwdRoot);
    const stderr = new CapturedOutput();
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(cwdRoot);
    process.env.HOME = homeRoot;
    process.env.USERPROFILE = homeRoot;
    try {
      const exitCode = await runMaterializeCli({
        request: 'request.json',
        inputRoot: 'input',
        outputRoot: 'output',
        result: 'result.json',
      }, stderr);

      expect(exitCode).toBe(0);
      expect(cwd).toHaveBeenCalled();
      expect(await fs.readFile(path.join(cwdRoot, 'cwd-canary'), 'utf8')).toBe('cwd-untouched');
      expect(await fs.readFile(path.join(homeRoot, 'home-canary'), 'utf8')).toBe('home-untouched');
      expect(await fs.readdir(homeRoot)).toEqual(['home-canary']);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it('returns an I/O exit code without leaking absolute paths to stderr', async () => {
    const fixture = await createFixture();
    const missingRequest = path.join(sandbox, 'private', 'missing-request.json');
    const options = { ...fixture.options, request: missingRequest };
    const stderr = new CapturedOutput();

    const exitCode = await runMaterializeCli(options, stderr);

    expect(exitCode).toBe(1);
    expect(parseDiagnostic(stderr)).toEqual({
      error: { code: 'MATERIALIZE_IO_ERROR', message: 'Materialization failed' },
      schema: MATERIALIZE_RESULT_SCHEMA,
      status: 'failed',
    });
    expectNoAbsolutePathLeak(stderr, options);
  });
});
