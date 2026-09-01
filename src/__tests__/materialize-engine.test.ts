import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MATERIALIZE_LAYOUT,
  MATERIALIZE_OPERATION,
  MATERIALIZE_REQUEST_SCHEMA,
  MATERIALIZE_RESULT_SCHEMA,
  MaterializeError,
  canonicalSha256,
  materializeSkills,
  requestSha256,
  validateMaterializeResult,
  type MaterializeFile,
  type MaterializeRequest,
} from '../materialize/index.js';

interface TestFile {
  path: string;
  bytes: Buffer;
  mode: '0644' | '0755';
}

let sandbox: string;
let inputRoot: string;
const execFileAsync = promisify(execFile);

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function entry(file: TestFile): MaterializeFile {
  return {
    path: file.path,
    sha256: hash(file.bytes),
    size: file.bytes.byteLength,
    mode: file.mode,
  };
}

function makeRequest(skills: Array<{ id: string; files: TestFile[] }>): MaterializeRequest {
  return {
    schema: MATERIALIZE_REQUEST_SCHEMA,
    operation: MATERIALIZE_OPERATION,
    target: { id: 'codex', layout: MATERIALIZE_LAYOUT },
    skills: skills.map((skill) => ({
      id: skill.id,
      files: skill.files.map(entry).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))),
    })).sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id))),
  };
}

async function writeInput(skills: Array<{ id: string; files: TestFile[] }>): Promise<void> {
  await fs.mkdir(inputRoot);
  for (const skill of skills) {
    const root = path.join(inputRoot, skill.id);
    await fs.mkdir(root);
    for (const file of skill.files) {
      const destination = path.join(root, ...file.path.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.bytes, { mode: Number.parseInt(file.mode, 8) });
      await fs.chmod(destination, Number.parseInt(file.mode, 8));
    }
  }
}

async function expectMaterializeError(
  promise: Promise<unknown>,
  code: MaterializeError['code'],
  exitCode: number,
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected materialization to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(MaterializeError);
    expect((error as MaterializeError).code).toBe(code);
    expect((error as MaterializeError).exitCode).toBe(exitCode);
  }
}

const STANDARD_SKILLS: Array<{ id: string; files: TestFile[] }> = [
  {
    id: 'alpha',
    files: [
      { path: 'SKILL.md', bytes: Buffer.from('# Alpha\n'), mode: '0644' },
      { path: 'assets/data.bin', bytes: Buffer.from([0, 1, 2, 255]), mode: '0644' },
      { path: 'bin/run.sh', bytes: Buffer.from('#!/bin/sh\necho alpha\n'), mode: '0755' },
    ],
  },
  {
    id: 'zeta',
    files: [{ path: 'SKILL.md', bytes: Buffer.from('# Zeta\r\n'), mode: '0644' }],
  },
];

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-materialize-'));
  inputRoot = path.join(sandbox, 'input');
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe('materializeSkills', () => {
  it('copies exhaustive Skill bytes and modes and emits stable canonical hashes', async () => {
    await writeInput(STANDARD_SKILLS);
    const request = makeRequest(STANDARD_SKILLS);
    const outputRoot = path.join(sandbox, 'output');
    const result = await materializeSkills(request, { inputRoot, outputRoot });

    expect(await fs.readFile(path.join(outputRoot, 'alpha', 'assets', 'data.bin')))
      .toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await fs.readFile(path.join(outputRoot, 'zeta', 'SKILL.md')))
      .toEqual(Buffer.from('# Zeta\r\n'));
    expect((await fs.stat(path.join(outputRoot, 'alpha', 'bin', 'run.sh'))).mode & 0o777).toBe(0o755);
    expect((await fs.stat(path.join(outputRoot, 'alpha', 'SKILL.md'))).mode & 0o777).toBe(0o644);

    const skills = request.skills.map((skill) => ({
      id: skill.id,
      files: skill.files.map((file) => ({ ...file })),
    }));
    expect(result).toMatchObject({
      schema: MATERIALIZE_RESULT_SCHEMA,
      status: 'succeeded',
      operation: MATERIALIZE_OPERATION,
      target: request.target,
      requestSha256: requestSha256(request),
      outputSha256: canonicalSha256({ schema: 'teamai.materialize.output/v1', skills }),
      skills,
    });
    const { resultSha256, ...payload } = result;
    expect(resultSha256).toBe(canonicalSha256(payload));
    expect(validateMaterializeResult(result, request)).toEqual(result);
    expect(() => validateMaterializeResult({ ...result, outputSha256: '0'.repeat(64) }, request))
      .toThrowError(MaterializeError);
    expect(JSON.stringify(result)).not.toContain(sandbox);
    expect(JSON.stringify(result)).not.toMatch(/timestamp|createdAt|202\d-/);
  });

  it('is deterministic across fresh output roots', async () => {
    await writeInput(STANDARD_SKILLS);
    const request = makeRequest(STANDARD_SKILLS);
    const first = await materializeSkills(request, {
      inputRoot,
      outputRoot: path.join(sandbox, 'output-a'),
    });
    const second = await materializeSkills(request, {
      inputRoot,
      outputRoot: path.join(sandbox, 'output-b'),
    });
    expect(second).toEqual(first);
  });

  it('rejects a self-consistent result that is unsafe or not bound to its request', async () => {
    await writeInput(STANDARD_SKILLS);
    const request = makeRequest(STANDARD_SKILLS);
    const result = await materializeSkills(request, {
      inputRoot,
      outputRoot: path.join(sandbox, 'output'),
    });
    const unsafeSkills = [{
      id: '../escape',
      files: result.skills[0].files,
    }];
    const unsafePayload = {
      ...result,
      skills: unsafeSkills,
      outputSha256: canonicalSha256({ schema: 'teamai.materialize.output/v1', skills: unsafeSkills }),
    };
    const { resultSha256: _oldHash, ...unsafeWithoutHash } = unsafePayload;
    const unsafeResult = { ...unsafeWithoutHash, resultSha256: canonicalSha256(unsafeWithoutHash) };
    try {
      validateMaterializeResult(unsafeResult, request);
      throw new Error('Expected unsafe result validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(MaterializeError);
      expect((error as MaterializeError).code).toBe('MATERIALIZE_INTEGRITY_MISMATCH');
    }

    const otherRequest = { ...request, target: { ...request.target, id: 'dsh' } };
    const { resultSha256: _resultHash, ...boundPayload } = result;
    const reboundPayload = {
      ...boundPayload,
      target: otherRequest.target,
      requestSha256: requestSha256(otherRequest),
    };
    const reboundResult = { ...reboundPayload, resultSha256: canonicalSha256(reboundPayload) };
    expect(() => validateMaterializeResult(reboundResult, request)).toThrowError(MaterializeError);
  });

  it('materializes a verified empty Skill set', async () => {
    await fs.mkdir(inputRoot);
    const request = makeRequest([]);
    const outputRoot = path.join(sandbox, 'empty-output');
    const result = await materializeSkills(request, { inputRoot, outputRoot });
    expect(await fs.readdir(outputRoot)).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(validateMaterializeResult(result, request)).toEqual(result);
  });

  it.each([
    ['unordered skills', (request: MaterializeRequest) => request.skills.reverse(), 'MATERIALIZE_INVALID_REQUEST'],
    ['duplicate skills', (request: MaterializeRequest) => request.skills.push(request.skills[0]), 'MATERIALIZE_INVALID_REQUEST'],
    ['missing SKILL.md', (request: MaterializeRequest) => { request.skills[0].files = request.skills[0].files.filter((f) => f.path !== 'SKILL.md'); }, 'MATERIALIZE_INPUT_INVALID'],
    ['unordered files', (request: MaterializeRequest) => request.skills[0].files.reverse(), 'MATERIALIZE_INVALID_REQUEST'],
    ['duplicate files', (request: MaterializeRequest) => request.skills[0].files.push(request.skills[0].files[0]), 'MATERIALIZE_INVALID_REQUEST'],
    ['parent traversal', (request: MaterializeRequest) => {
      request.skills[0].files[1].path = 'z/../escape';
      request.skills[0].files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    }, 'MATERIALIZE_UNSAFE_PATH'],
    ['backslash', (request: MaterializeRequest) => {
      request.skills[0].files[1].path = 'z\\escape';
      request.skills[0].files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    }, 'MATERIALIZE_UNSAFE_PATH'],
    ['drive path', (request: MaterializeRequest) => {
      request.skills[0].files[1].path = 'Z:/escape';
      request.skills[0].files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    }, 'MATERIALIZE_UNSAFE_PATH'],
    ['reserved Windows name', (request: MaterializeRequest) => {
      request.skills[0].files[1].path = 'z/CON';
      request.skills[0].files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    }, 'MATERIALIZE_UNSAFE_PATH'],
    ['Windows trailing dot', (request: MaterializeRequest) => {
      request.skills[0].files[1].path = 'z./escape';
      request.skills[0].files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    }, 'MATERIALIZE_UNSAFE_PATH'],
    ['non-NFC path', (request: MaterializeRequest) => {
      request.skills[0].files[1].path = 'z/e\u0301';
      request.skills[0].files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    }, 'MATERIALIZE_UNSAFE_PATH'],
    ['Windows-forbidden character', (request: MaterializeRequest) => {
      request.skills[0].files[1].path = 'z/bad?.txt';
      request.skills[0].files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    }, 'MATERIALIZE_UNSAFE_PATH'],
    ['overlong path segment', (request: MaterializeRequest) => {
      request.skills[0].files[1].path = `z/${'a'.repeat(256)}`;
      request.skills[0].files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    }, 'MATERIALIZE_UNSAFE_PATH'],
  ] as const)('rejects %s', async (_label, mutate, code) => {
    await writeInput(STANDARD_SKILLS);
    const request = structuredClone(makeRequest(STANDARD_SKILLS));
    mutate(request);
    await expectMaterializeError(
      materializeSkills(request, { inputRoot, outputRoot: path.join(sandbox, 'output') }),
      code,
      code === 'MATERIALIZE_INPUT_INVALID' ? 3 : 2,
    );
  });

  it('rejects case-colliding files', async () => {
    const skills = [{
      id: 'alpha',
      files: [
        { path: 'SKILL.md', bytes: Buffer.from('one'), mode: '0644' as const },
        { path: 'a.txt', bytes: Buffer.from('a'), mode: '0644' as const },
        { path: 'A.txt', bytes: Buffer.from('A'), mode: '0644' as const },
      ],
    }];
    await writeInput(skills);
    await expectMaterializeError(
      materializeSkills(makeRequest(skills), { inputRoot, outputRoot: path.join(sandbox, 'output') }),
      'MATERIALIZE_UNSAFE_PATH',
      2,
    );
  });

  it.each([
    ['hash', (file: MaterializeFile) => { file.sha256 = 'f'.repeat(64); }],
    ['size', (file: MaterializeFile) => { file.size += 1; }],
    ['mode', (file: MaterializeFile) => { file.mode = file.mode === '0644' ? '0755' : '0644'; }],
  ])('rejects an input %s mismatch before creating output', async (_label, mutate) => {
    await writeInput(STANDARD_SKILLS);
    const request = structuredClone(makeRequest(STANDARD_SKILLS));
    mutate(request.skills[0].files[0]);
    const outputRoot = path.join(sandbox, 'output');
    await expectMaterializeError(
      materializeSkills(request, { inputRoot, outputRoot }),
      'MATERIALIZE_INTEGRITY_MISMATCH',
      3,
    );
    await expect(fs.lstat(outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symbolic link in the input tree', async () => {
    const skills = [{
      id: 'alpha',
      files: [
        { path: 'SKILL.md', bytes: Buffer.from('skill'), mode: '0644' as const },
        { path: 'linked.txt', bytes: Buffer.from('outside'), mode: '0644' as const },
      ],
    }];
    await writeInput([{ id: 'alpha', files: [skills[0].files[0]] }]);
    const outside = path.join(sandbox, 'outside.txt');
    await fs.writeFile(outside, 'outside');
    await fs.symlink(outside, path.join(inputRoot, 'alpha', 'linked.txt'));

    await expectMaterializeError(
      materializeSkills(makeRequest(skills), { inputRoot, outputRoot: path.join(sandbox, 'output') }),
      'MATERIALIZE_INPUT_INVALID',
      3,
    );
  });

  it('rejects a hard-linked input file', async () => {
    const skills = [{
      id: 'alpha',
      files: [
        { path: 'SKILL.md', bytes: Buffer.from('skill'), mode: '0644' as const },
        { path: 'copy.md', bytes: Buffer.from('skill'), mode: '0644' as const },
      ],
    }];
    await fs.mkdir(path.join(inputRoot, 'alpha'), { recursive: true });
    const skillMd = path.join(inputRoot, 'alpha', 'SKILL.md');
    await fs.writeFile(skillMd, 'skill', { mode: 0o644 });
    await fs.link(skillMd, path.join(inputRoot, 'alpha', 'copy.md'));
    await expectMaterializeError(
      materializeSkills(makeRequest(skills), { inputRoot, outputRoot: path.join(sandbox, 'output') }),
      'MATERIALIZE_INPUT_INVALID',
      3,
    );
  });

  it.runIf(process.platform !== 'win32')('rejects a special file in the input tree', async () => {
    const skills = [{
      id: 'alpha',
      files: [
        { path: 'SKILL.md', bytes: Buffer.from('skill'), mode: '0644' as const },
        { path: 'special.sock', bytes: Buffer.alloc(0), mode: '0644' as const },
      ],
    }];
    await writeInput([{ id: 'alpha', files: [skills[0].files[0]] }]);
    const specialPath = path.join(inputRoot, 'alpha', 'special.sock');
    await execFileAsync('mkfifo', [specialPath]);
    await expectMaterializeError(
      materializeSkills(makeRequest(skills), { inputRoot, outputRoot: path.join(sandbox, 'output') }),
      'MATERIALIZE_INPUT_INVALID',
      3,
    );
  });

  it('rejects an existing output root without changing it', async () => {
    await writeInput(STANDARD_SKILLS);
    const outputRoot = path.join(sandbox, 'output');
    await fs.mkdir(outputRoot);
    await fs.writeFile(path.join(outputRoot, 'sentinel'), 'keep');
    await expectMaterializeError(
      materializeSkills(makeRequest(STANDARD_SKILLS), { inputRoot, outputRoot }),
      'MATERIALIZE_OUTPUT_EXISTS',
      4,
    );
    expect(await fs.readFile(path.join(outputRoot, 'sentinel'), 'utf8')).toBe('keep');
  });

  it.each([
    ['an extra skill', async () => fs.mkdir(path.join(inputRoot, 'extra'))],
    ['an extra file', async () => fs.writeFile(path.join(inputRoot, 'alpha', 'extra.txt'), 'extra')],
    ['an extra empty directory', async () => fs.mkdir(path.join(inputRoot, 'alpha', 'empty'))],
  ])('rejects %s in the input root', async (_label, addExtra) => {
    await writeInput(STANDARD_SKILLS);
    await addExtra();
    await expectMaterializeError(
      materializeSkills(makeRequest(STANDARD_SKILLS), {
        inputRoot,
        outputRoot: path.join(sandbox, 'output'),
      }),
      'MATERIALIZE_INPUT_INVALID',
      3,
    );
  });

  it.each([
    ['skills', { maxSkills: 1 }],
    ['files', { maxFiles: 2 }],
    ['directories', { maxDirectories: 1 }],
    ['file bytes', { maxFileBytes: 3 }],
    ['total bytes', { maxTotalBytes: 8 }],
    ['path bytes', { maxPathBytes: 7 }],
    ['path depth', { maxPathDepth: 1 }],
  ])('enforces the %s resource limit', async (_label, limits) => {
    await writeInput(STANDARD_SKILLS);
    await expectMaterializeError(
      materializeSkills(makeRequest(STANDARD_SKILLS), {
        inputRoot,
        outputRoot: path.join(sandbox, 'output'),
        limits,
      }),
      'MATERIALIZE_LIMIT_EXCEEDED',
      2,
    );
  });
});
