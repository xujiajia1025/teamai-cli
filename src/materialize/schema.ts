import { z } from 'zod';
import { canonicalSha256 } from './canonical.js';
import { MaterializeError } from './errors.js';
import {
  collisionKey,
  requireCanonicalOrder,
  requireNoPortableCollisions,
  validateFilePath,
  validateSkillId,
  type PathLimits,
} from './paths.js';

export const MATERIALIZE_REQUEST_SCHEMA = 'teamai.materialize.request/v1' as const;
export const MATERIALIZE_RESULT_SCHEMA = 'teamai.materialize.result/v1' as const;
export const MATERIALIZE_OPERATION = 'copy-skills' as const;
export const MATERIALIZE_LAYOUT = 'flat-skill-root/v1' as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const modeSchema = z.enum(['0644', '0755']);

const fileSchema = z.object({
  path: z.string().min(1),
  sha256: sha256Schema,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mode: modeSchema,
}).strict();

const skillSchema = z.object({
  id: z.string().min(1),
  files: z.array(fileSchema).min(1),
}).strict();

const targetSchema = z.object({
  id: z.string().min(1),
  layout: z.literal(MATERIALIZE_LAYOUT),
}).strict();

export const materializeRequestSchema = z.object({
  schema: z.literal(MATERIALIZE_REQUEST_SCHEMA),
  operation: z.literal(MATERIALIZE_OPERATION),
  target: targetSchema,
  skills: z.array(skillSchema),
}).strict();

export type MaterializeFile = z.infer<typeof fileSchema>;
export type MaterializeSkill = z.infer<typeof skillSchema>;
export type MaterializeRequest = z.infer<typeof materializeRequestSchema>;

export interface MaterializeLimits extends PathLimits {
  maxSkills: number;
  maxFiles: number;
  maxDirectories: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_MATERIALIZE_LIMITS: Readonly<MaterializeLimits> = Object.freeze({
  maxSkills: 256,
  maxFiles: 8_192,
  maxDirectories: 8_192,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxPathBytes: 1_024,
  maxPathDepth: 32,
});

export interface ValidatedMaterializePlan {
  request: MaterializeRequest;
  limits: MaterializeLimits;
  expectedDirectories: Map<string, Set<string>>;
}

export interface MaterializeResult {
  schema: typeof MATERIALIZE_RESULT_SCHEMA;
  status: 'succeeded';
  operation: typeof MATERIALIZE_OPERATION;
  target: MaterializeRequest['target'];
  requestSha256: string;
  outputSha256: string;
  resultSha256: string;
  skills: MaterializeSkill[];
}

export const materializeResultSchema = z.object({
  schema: z.literal(MATERIALIZE_RESULT_SCHEMA),
  status: z.literal('succeeded'),
  operation: z.literal(MATERIALIZE_OPERATION),
  target: targetSchema,
  requestSha256: sha256Schema,
  outputSha256: sha256Schema,
  resultSha256: sha256Schema,
  skills: z.array(skillSchema),
}).strict();

export const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/** JSON.parse accepts duplicate object keys. Reject them before trusting the decoded request. */
function assertNoDuplicateObjectKeys(text: string): void {
  let offset = 0;
  const whitespace = (): void => {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[offset])) offset += 1;
  };
  const stringToken = (): string => {
    const start = offset;
    offset += 1; // opening quote; JSON.parse already proved the token stream is valid
    while (offset < text.length) {
      if (text[offset] === '\\') {
        offset += 2;
      } else if (text[offset] === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset)) as string;
      } else {
        offset += 1;
      }
    }
    return '';
  };
  const value = (): void => {
    whitespace();
    if (text[offset] === '{') {
      offset += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[offset] === '}') {
        offset += 1;
        return;
      }
      for (;;) {
        whitespace();
        const key = stringToken();
        if (keys.has(key)) {
          throw new MaterializeError('MATERIALIZE_INVALID_REQUEST', 'Materialize request contains a duplicate object key');
        }
        keys.add(key);
        whitespace();
        offset += 1; // colon
        value();
        whitespace();
        if (text[offset] === '}') {
          offset += 1;
          return;
        }
        offset += 1; // comma
      }
    }
    if (text[offset] === '[') {
      offset += 1;
      whitespace();
      if (text[offset] === ']') {
        offset += 1;
        return;
      }
      for (;;) {
        value();
        whitespace();
        if (text[offset] === ']') {
          offset += 1;
          return;
        }
        offset += 1; // comma
      }
    }
    if (text[offset] === '"') {
      stringToken();
      return;
    }
    while (offset < text.length && !/[\s,\]}]/.test(text[offset])) offset += 1;
  };
  value();
}

/** Parse either JSON text or an already-decoded value using the strict v1 schema. */
export function parseMaterializeRequest(
  value: string | unknown,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
): MaterializeRequest {
  let decoded: unknown = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > maxRequestBytes) {
      throw new MaterializeError('MATERIALIZE_LIMIT_EXCEEDED', 'Materialize request exceeds the byte limit');
    }
    try {
      decoded = JSON.parse(value) as unknown;
      assertNoDuplicateObjectKeys(value);
    } catch (error) {
      if (error instanceof MaterializeError) throw error;
      throw new MaterializeError('MATERIALIZE_INVALID_REQUEST', 'Materialize request is not valid JSON', {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
  return validateMaterializeRequest(decoded);
}

function decodeMaterializeRequest(value: unknown): MaterializeRequest {
  const parsed = materializeRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new MaterializeError('MATERIALIZE_INVALID_REQUEST', 'Materialize request does not conform to v1');
  }
  return parsed.data;
}

function mergeLimits(overrides: Partial<MaterializeLimits> | undefined): MaterializeLimits {
  const limits = { ...DEFAULT_MATERIALIZE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new MaterializeError('MATERIALIZE_INVALID_REQUEST', `Invalid materialize limit: ${name}`);
    }
  }
  return limits;
}

function validatePortableTree(files: MaterializeFile[], limits: MaterializeLimits): Set<string> {
  const nodes = new Map<string, { spelling: string; kind: 'directory' | 'file' }>();
  const directories = new Set<string>();
  for (const file of files) {
    const segments = validateFilePath(file.path, limits);
    for (let index = 1; index < segments.length; index += 1) {
      const directory = segments.slice(0, index).join('/');
      const key = collisionKey(directory);
      const existing = nodes.get(key);
      if (existing && (existing.spelling !== directory || existing.kind !== 'directory')) {
        throw new MaterializeError('MATERIALIZE_UNSAFE_PATH', 'File tree contains a portable path collision');
      }
      nodes.set(key, { spelling: directory, kind: 'directory' });
      directories.add(directory);
    }
    const key = collisionKey(file.path);
    if (nodes.has(key)) {
      throw new MaterializeError('MATERIALIZE_UNSAFE_PATH', 'File tree contains a portable path collision');
    }
    nodes.set(key, { spelling: file.path, kind: 'file' });
  }
  return directories;
}

/** Validate the complete pure v1 contract without touching the filesystem. */
export function validateMaterializePlan(
  value: unknown,
  overrides?: Partial<MaterializeLimits>,
): ValidatedMaterializePlan {
  const request = decodeMaterializeRequest(value);
  const limits = mergeLimits(overrides);
  validateSkillId(request.target.id);
  if (request.skills.length > limits.maxSkills) {
    throw new MaterializeError('MATERIALIZE_LIMIT_EXCEEDED', 'Skill count exceeds the configured limit');
  }
  const skillIds = request.skills.map((skill) => skill.id);
  requireCanonicalOrder(skillIds, 'Skills');
  requireNoPortableCollisions(skillIds, 'Skills');

  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;
  const expectedDirectories = new Map<string, Set<string>>();
  for (const skill of request.skills) {
    validateSkillId(skill.id);
    const filePaths = skill.files.map((file) => file.path);
    requireCanonicalOrder(filePaths, `Files for skill ${skill.id}`);
    requireNoPortableCollisions(filePaths, `Files for skill ${skill.id}`);
    if (!filePaths.includes('SKILL.md')) {
      throw new MaterializeError('MATERIALIZE_INPUT_INVALID', `Skill ${skill.id} does not declare SKILL.md`);
    }
    const directories = validatePortableTree(skill.files, limits);
    directoryCount += directories.size;
    if (directoryCount > limits.maxDirectories) {
      throw new MaterializeError('MATERIALIZE_LIMIT_EXCEEDED', 'Directory count exceeds the configured limit');
    }
    expectedDirectories.set(skill.id, directories);

    fileCount += skill.files.length;
    if (fileCount > limits.maxFiles) {
      throw new MaterializeError('MATERIALIZE_LIMIT_EXCEEDED', 'File count exceeds the configured limit');
    }
    for (const file of skill.files) {
      if (file.size > limits.maxFileBytes) {
        throw new MaterializeError('MATERIALIZE_LIMIT_EXCEEDED', 'File size exceeds the configured limit');
      }
      if (totalBytes > limits.maxTotalBytes - file.size) {
        throw new MaterializeError('MATERIALIZE_LIMIT_EXCEEDED', 'Total byte size exceeds the configured limit');
      }
      totalBytes += file.size;
    }
  }
  return { request, limits, expectedDirectories };
}

export function validateMaterializeRequest(
  value: unknown,
  limits?: Partial<MaterializeLimits>,
): MaterializeRequest {
  return validateMaterializePlan(value, limits).request;
}

export function requestSha256(request: MaterializeRequest): string {
  return canonicalSha256(request);
}

/** Strictly validate a success result, including its self-excluding canonical hash. */
export function validateMaterializeResult(
  value: unknown,
  expectedRequestValue: unknown,
  limits?: Partial<MaterializeLimits>,
): MaterializeResult {
  const expectedRequest = validateMaterializeRequest(expectedRequestValue, limits);
  const parsed = materializeResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new MaterializeError('MATERIALIZE_INVALID_REQUEST', 'Materialize result does not conform to v1');
  }
  const { resultSha256, ...payload } = parsed.data;
  if (canonicalSha256(payload) !== resultSha256) {
    throw new MaterializeError('MATERIALIZE_INTEGRITY_MISMATCH', 'Materialize result hash does not match');
  }
  try {
    validateMaterializePlan({
      schema: MATERIALIZE_REQUEST_SCHEMA,
      operation: parsed.data.operation,
      target: parsed.data.target,
      skills: parsed.data.skills,
    }, limits);
  } catch (error) {
    throw new MaterializeError('MATERIALIZE_INTEGRITY_MISMATCH', 'Materialize result violates the v1 contract', {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (parsed.data.requestSha256 !== requestSha256(expectedRequest)
    || canonicalSha256(parsed.data.target) !== canonicalSha256(expectedRequest.target)
    || canonicalSha256(parsed.data.skills) !== canonicalSha256(expectedRequest.skills)) {
    throw new MaterializeError('MATERIALIZE_INTEGRITY_MISMATCH', 'Materialize result is not bound to the request');
  }
  const expectedOutput = canonicalSha256({ schema: 'teamai.materialize.output/v1', skills: parsed.data.skills });
  if (expectedOutput !== parsed.data.outputSha256) {
    throw new MaterializeError('MATERIALIZE_INTEGRITY_MISMATCH', 'Materialize output hash does not match');
  }
  return parsed.data;
}
