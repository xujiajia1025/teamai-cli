import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import {
  DEFAULT_MAX_REQUEST_BYTES,
  MATERIALIZE_RESULT_SCHEMA,
  MaterializeError,
  asMaterializeError,
  canonicalJson,
  materializeSkills,
  parseMaterializeRequest,
} from './materialize/index.js';

export interface MaterializeCliOptions {
  request: string;
  inputRoot: string;
  outputRoot: string;
  result: string;
}

interface MaterializeFailureResult {
  schema: typeof MATERIALIZE_RESULT_SCHEMA;
  status: 'failed';
  error: {
    code: string;
    message: string;
  };
}

interface PathTopology {
  requestPath: string;
  inputRoot: string;
  outputRoot: string;
  resultPath: string;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function overlaps(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  if (relative === '') return true;
  if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return true;
  const reverse = path.relative(right, left);
  return reverse !== '..' && !reverse.startsWith(`..${path.sep}`) && !path.isAbsolute(reverse);
}

async function requireRegularFile(filePath: string, label: string): Promise<string> {
  const absolute = path.resolve(filePath);
  const stat = await fs.lstat(absolute, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new MaterializeError('MATERIALIZE_UNSAFE_PATH', `${label} must be a regular file`);
  }
  return fs.realpath(absolute);
}

async function requireRegularDirectory(directory: string, label: string): Promise<string> {
  const absolute = path.resolve(directory);
  const stat = await fs.lstat(absolute, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new MaterializeError('MATERIALIZE_UNSAFE_PATH', `${label} must be a regular directory`);
  }
  return fs.realpath(absolute);
}

async function resolveFreshPath(candidate: string, label: string): Promise<string> {
  const absolute = path.resolve(candidate);
  if (path.dirname(absolute) === absolute) {
    throw new MaterializeError('MATERIALIZE_UNSAFE_PATH', `${label} cannot be a filesystem root`);
  }
  try {
    await fs.lstat(absolute);
    throw new MaterializeError('MATERIALIZE_OUTPUT_EXISTS', `${label} already exists`);
  } catch (error) {
    if (error instanceof MaterializeError) throw error;
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
  const parent = await requireRegularDirectory(path.dirname(absolute), `${label} parent`);
  return path.join(parent, path.basename(absolute));
}

async function resolveTopology(options: MaterializeCliOptions): Promise<PathTopology> {
  const topology: PathTopology = {
    requestPath: await requireRegularFile(options.request, 'Request'),
    inputRoot: await requireRegularDirectory(options.inputRoot, 'Input root'),
    outputRoot: await resolveFreshPath(options.outputRoot, 'Output root'),
    resultPath: await resolveFreshPath(options.result, 'Result file'),
  };
  const paths = Object.entries(topology);
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (overlaps(paths[left][1], paths[right][1])) {
        throw new MaterializeError(
          'MATERIALIZE_UNSAFE_PATH',
          `${paths[left][0]} and ${paths[right][0]} must not overlap`,
        );
      }
    }
  }
  return topology;
}

async function readStableRequest(requestPath: string): Promise<string> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(requestPath, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new MaterializeError('MATERIALIZE_UNSAFE_PATH', 'Request must be a private regular file');
    }
    if (before.size > BigInt(DEFAULT_MAX_REQUEST_BYTES)) {
      throw new MaterializeError('MATERIALIZE_LIMIT_EXCEEDED', 'Materialize request exceeds the byte limit');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || BigInt(bytes.byteLength) !== before.size
    ) {
      throw new MaterializeError('MATERIALIZE_INTEGRITY_MISMATCH', 'Request changed while it was read');
    }
    return bytes.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(
    directory,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeFreshJson(destination: string, value: unknown): Promise<void> {
  const content = `${canonicalJson(value)}\n`;
  const expectedSize = BigInt(Buffer.byteLength(content, 'utf8'));
  let created = false;
  let handle;
  try {
    handle = await fs.open(destination, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    created = true;
    await handle.writeFile(content, 'utf8');
    await handle.chmod(0o600);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== expectedSize
      || Number(stat.mode & 0o7777n) !== 0o600) {
      throw new MaterializeError('MATERIALIZE_INTEGRITY_MISMATCH', 'Result metadata does not match v1');
    }
    await handle.sync();
    await syncDirectory(path.dirname(destination));
  } catch (error) {
    if (created) await fs.unlink(destination).catch(() => undefined);
    if (isNodeError(error, 'EEXIST')) {
      throw new MaterializeError('MATERIALIZE_OUTPUT_EXISTS', 'Result file already exists');
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function failureResult(error: MaterializeError): MaterializeFailureResult {
  return {
    schema: MATERIALIZE_RESULT_SCHEMA,
    status: 'failed',
    error: { code: error.code, message: error.message },
  };
}

/** Run the isolated CLI contract. stdout stays empty; diagnostics use one JSON stderr line. */
export async function runMaterializeCli(
  options: MaterializeCliOptions,
  stderr: Writable = process.stderr,
): Promise<number> {
  let resultPath: string | undefined;
  try {
    const topology = await resolveTopology(options);
    resultPath = topology.resultPath;
    const request = parseMaterializeRequest(await readStableRequest(topology.requestPath));
    const result = await materializeSkills(request, {
      inputRoot: topology.inputRoot,
      outputRoot: topology.outputRoot,
    });
    await writeFreshJson(topology.resultPath, result);
    return 0;
  } catch (caught) {
    const error = asMaterializeError(caught);
    const failed = failureResult(error);
    if (resultPath) {
      await writeFreshJson(resultPath, failed).catch(() => undefined);
    }
    stderr.write(`${canonicalJson(failed)}\n`);
    return error.exitCode;
  }
}
