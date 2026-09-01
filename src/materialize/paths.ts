import path from 'node:path';
import { Buffer } from 'node:buffer';
import { compareUtf8 } from './canonical.js';
import { MaterializeError } from './errors.js';

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const WINDOWS_FORBIDDEN = /[<>"|?*]/;
const SAFE_SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface PathLimits {
  maxPathBytes: number;
  maxPathDepth: number;
}

function unsafe(message: string): never {
  throw new MaterializeError('MATERIALIZE_UNSAFE_PATH', message);
}

function validateSegment(segment: string, label: string): void {
  if (segment.length === 0 || segment === '.' || segment === '..') unsafe(`${label} contains an unsafe segment`);
  if (segment !== segment.normalize('NFC')) unsafe(`${label} must use Unicode NFC`);
  if (CONTROL_CHARACTER.test(segment)) unsafe(`${label} contains a control character`);
  if (WINDOWS_FORBIDDEN.test(segment)) unsafe(`${label} contains a Windows-forbidden character`);
  if (segment.includes(':')) unsafe(`${label} contains a Windows alternate-stream separator`);
  if (Buffer.byteLength(segment, 'utf8') > 255) unsafe(`${label} segment exceeds the portable byte limit`);
  if (segment.endsWith('.') || segment.endsWith(' ')) unsafe(`${label} has a Windows-unsafe suffix`);
  if (WINDOWS_RESERVED.test(segment)) unsafe(`${label} contains a Windows reserved name`);
}

export function validateSkillId(id: string): void {
  if (!SAFE_SKILL_ID.test(id)) {
    unsafe('Skill id must be 1-64 ASCII characters from [A-Za-z0-9._-] and start with alphanumeric');
  }
  validateSegment(id, 'Skill id');
}

/** Validate and return canonical POSIX request path segments. */
export function validateFilePath(value: string, limits: PathLimits): string[] {
  if (value.includes('\\')) unsafe('File path must use POSIX separators');
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) unsafe('File path must be relative');
  if (Buffer.byteLength(value, 'utf8') > limits.maxPathBytes) {
    throw new MaterializeError('MATERIALIZE_LIMIT_EXCEEDED', 'File path exceeds the byte limit');
  }
  const segments = value.split('/');
  if (segments.length > limits.maxPathDepth) {
    throw new MaterializeError('MATERIALIZE_LIMIT_EXCEEDED', 'File path exceeds the depth limit');
  }
  for (const segment of segments) validateSegment(segment, 'File path');
  if (segments.join('/') !== value || path.posix.normalize(value) !== value) unsafe('File path is not canonical');
  return segments;
}

export function collisionKey(value: string): string {
  // upper-then-lower catches expanding folds such as German sharp-s -> "ss".
  return value.normalize('NFC').toUpperCase().toLowerCase();
}

export function requireCanonicalOrder(values: string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareUtf8(values[index - 1], values[index]) >= 0) {
      throw new MaterializeError(
        'MATERIALIZE_INVALID_REQUEST',
        `${label} must be strictly ordered and unique`,
      );
    }
  }
}

export function requireNoPortableCollisions(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = collisionKey(value);
    if (seen.has(key)) {
      throw new MaterializeError('MATERIALIZE_UNSAFE_PATH', `${label} contains a case or Unicode collision`);
    }
    seen.add(key);
  }
}

export function joinContained(root: string, segments: string[]): string {
  const candidate = path.join(root, ...segments);
  const relative = path.relative(root, candidate);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    unsafe('Resolved path escapes its root');
  }
  return candidate;
}
