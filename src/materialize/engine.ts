import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalSha256, compareUtf8 } from './canonical.js';
import { asMaterializeError, MaterializeError } from './errors.js';
import {
  joinContained,
  validateFilePath,
} from './paths.js';
import {
  MATERIALIZE_OPERATION,
  MATERIALIZE_RESULT_SCHEMA,
  requestSha256,
  validateMaterializePlan,
  type MaterializeFile,
  type MaterializeLimits,
  type MaterializeRequest,
  type MaterializeResult,
  type MaterializeSkill,
  type ValidatedMaterializePlan,
} from './schema.js';

export interface MaterializeOptions {
  /** Roots must live in a caller-owned sandbox with no concurrent namespace mutator. */
  inputRoot: string;
  outputRoot: string;
  limits?: Partial<MaterializeLimits>;
}

type ValidatedPlan = ValidatedMaterializePlan;

interface FileSnapshot {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: number;
  nlink: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface TreeScanBudget {
  files: number;
  directories: number;
}

type TreePurpose = 'input' | 'output';

function rejectInvalidNode(purpose: TreePurpose, message: string): never {
  if (purpose === 'output') integrityError(message);
  return inputError(message);
}

function limitError(message: string): never {
  throw new MaterializeError('MATERIALIZE_LIMIT_EXCEEDED', message);
}

function inputError(message: string): never {
  throw new MaterializeError('MATERIALIZE_INPUT_INVALID', message);
}

function integrityError(message: string): never {
  throw new MaterializeError('MATERIALIZE_INTEGRITY_MISMATCH', message);
}

async function bigintSnapshot(filePath: string): Promise<FileSnapshot> {
  const stat = await fs.lstat(filePath, { bigint: true });
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: Number(stat.mode & 0o7777n),
    nlink: stat.nlink,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameIdentity(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: FileSnapshot, right: FileSnapshot): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function assertOpenedPathBinding(
  filePath: string,
  opened: FileSnapshot,
  reject: (message: string) => never,
): Promise<void> {
  const realPath = await fs.realpath(filePath);
  const current = await bigintSnapshot(filePath);
  if (realPath !== path.resolve(filePath) || !sameIdentity(opened, current)) {
    reject('Filesystem path changed while its file descriptor was being bound');
  }
}

function expectedMode(file: MaterializeFile): number {
  return file.mode === '0755' ? 0o755 : 0o644;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

async function requireDirectory(directory: string, label: string): Promise<string> {
  let stat;
  try {
    stat = await fs.lstat(directory, { bigint: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) inputError(`${label} does not exist`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) inputError(`${label} must be a regular directory`);
  return fs.realpath(directory);
}

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  if (relative === '') return true;
  if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return true;
  const reverse = path.relative(right, left);
  return reverse !== '..' && !reverse.startsWith(`..${path.sep}`) && !path.isAbsolute(reverse);
}

async function resolveFreshOutput(inputRoot: string, outputRoot: string): Promise<string> {
  const absoluteOutput = path.resolve(outputRoot);
  const parent = path.dirname(absoluteOutput);
  if (parent === absoluteOutput) {
    throw new MaterializeError('MATERIALIZE_UNSAFE_PATH', 'Output root cannot be a filesystem root');
  }
  try {
    await fs.lstat(absoluteOutput);
    throw new MaterializeError('MATERIALIZE_OUTPUT_EXISTS', 'Output root already exists');
  } catch (error) {
    if (error instanceof MaterializeError) throw error;
    if (!isNodeError(error, 'ENOENT')) throw error;
  }

  const realParent = await requireDirectory(parent, 'Output parent');
  const canonicalOutput = path.join(realParent, path.basename(absoluteOutput));
  if (pathsOverlap(inputRoot, canonicalOutput)) {
    throw new MaterializeError('MATERIALIZE_UNSAFE_PATH', 'Input and output roots must not overlap');
  }
  return canonicalOutput;
}

async function listDirectoryNames(directory: string, maxEntries: number): Promise<string[]> {
  const names: string[] = [];
  const handle = await fs.opendir(directory);
  for await (const entry of handle) {
    names.push(entry.name);
    if (names.length > maxEntries) limitError('Directory entry count exceeds the configured limit');
  }
  names.sort(compareUtf8);
  return names;
}

async function scanSkillTree(
  skillRoot: string,
  limits: MaterializeLimits,
  budget: TreeScanBudget,
  purpose: TreePurpose,
): Promise<{
  files: string[];
  directories: Set<string>;
}> {
  const files: string[] = [];
  const directories = new Set<string>();

  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const before = await bigintSnapshot(directory);
    const beforeStat = await fs.lstat(directory, { bigint: true });
    if (beforeStat.isSymbolicLink() || !beforeStat.isDirectory()) {
      rejectInvalidNode(purpose, 'Skill tree contains a non-directory node');
    }
    const expectedRealPath = path.resolve(directory);
    if (await fs.realpath(directory) !== expectedRealPath) {
      rejectInvalidNode(purpose, 'Skill tree contains a symbolic-link directory');
    }

    const remainingEntries = (limits.maxFiles - budget.files) + (limits.maxDirectories - budget.directories);
    for (const name of await listDirectoryNames(directory, remainingEntries)) {
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      validateFilePath(relative, limits);
      const child = joinContained(skillRoot, relative.split('/'));
      const stat = await fs.lstat(child, { bigint: true });
      if (stat.isSymbolicLink()) rejectInvalidNode(purpose, 'Skill tree contains a symbolic link');
      if (stat.isDirectory()) {
        budget.directories += 1;
        if (budget.directories > limits.maxDirectories) limitError('Directory count exceeds the configured limit');
        directories.add(relative);
        await walk(child, relative);
      } else if (stat.isFile()) {
        budget.files += 1;
        if (budget.files > limits.maxFiles) limitError('File count exceeds the configured limit');
        if (stat.nlink !== 1n) rejectInvalidNode(purpose, 'Skill tree contains a hard-linked file');
        files.push(relative);
      } else {
        rejectInvalidNode(purpose, 'Skill tree contains a special file');
      }
    }

    const after = await bigintSnapshot(directory);
    if (!sameStableFile(before, after)) integrityError('Input directory changed while it was scanned');
  };

  await walk(skillRoot, '');
  files.sort(compareUtf8);
  return { files, directories };
}

function sameStrings(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = [...left].sort(compareUtf8);
  const b = [...right].sort(compareUtf8);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function validateInputLayout(plan: ValidatedPlan, inputRoot: string): Promise<void> {
  const names = await listDirectoryNames(inputRoot, plan.limits.maxSkills);
  const skillIds = plan.request.skills.map((skill) => skill.id);
  if (!sameStrings(names, skillIds)) inputError('Input root does not exactly match the declared skills');

  const budget: TreeScanBudget = { files: 0, directories: 0 };
  for (const skill of plan.request.skills) {
    const skillRoot = joinContained(inputRoot, [skill.id]);
    const stat = await fs.lstat(skillRoot, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) inputError('Each input skill must be a regular directory');
    const scanned = await scanSkillTree(skillRoot, plan.limits, budget, 'input');
    if (!sameStrings(scanned.files, skill.files.map((file) => file.path))) {
      inputError(`Input files for skill ${skill.id} do not exactly match the request`);
    }
    if (!sameStrings(scanned.directories, plan.expectedDirectories.get(skill.id) ?? [])) {
      inputError(`Input directories for skill ${skill.id} do not exactly match the request`);
    }
  }
}

async function readAndHashSecure(
  filePath: string,
  expected: MaterializeFile,
  purpose: TreePurpose,
): Promise<string> {
  const beforeStat = await fs.lstat(filePath, { bigint: true });
  if (beforeStat.isSymbolicLink() || !beforeStat.isFile()) {
    rejectInvalidNode(purpose, 'Declared tree entry is not a regular file');
  }
  if (beforeStat.nlink !== 1n) rejectInvalidNode(purpose, 'Declared tree entry is hard linked');
  const before = await bigintSnapshot(filePath);

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | noFollow | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const openedStat = await handle.stat({ bigint: true });
    const opened: FileSnapshot = {
      dev: openedStat.dev,
      ino: openedStat.ino,
      size: openedStat.size,
      mode: Number(openedStat.mode & 0o7777n),
      nlink: openedStat.nlink,
      mtimeNs: openedStat.mtimeNs,
      ctimeNs: openedStat.ctimeNs,
    };
    if (!openedStat.isFile() || opened.nlink !== 1n || !sameIdentity(before, opened)) {
      integrityError('Input file changed before it could be opened');
    }
    await assertOpenedPathBinding(
      filePath,
      opened,
      purpose === 'input' ? inputError : integrityError,
    );
    if (opened.size !== BigInt(expected.size)) integrityError('Input file size does not match the request');
    if (opened.mode !== expectedMode(expected)) integrityError('Input file mode does not match the request');

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }

    const afterStat = await handle.stat({ bigint: true });
    const after: FileSnapshot = {
      dev: afterStat.dev,
      ino: afterStat.ino,
      size: afterStat.size,
      mode: Number(afterStat.mode & 0o7777n),
      nlink: afterStat.nlink,
      mtimeNs: afterStat.mtimeNs,
      ctimeNs: afterStat.ctimeNs,
    };
    if (!afterStat.isFile() || !sameStableFile(opened, after) || bytes !== expected.size) {
      integrityError('Input file changed while it was read');
    }
    const digest = hash.digest('hex');
    if (digest !== expected.sha256) integrityError('Input file hash does not match the request');
    return digest;
  } finally {
    await handle.close();
  }
}

async function validateInputFiles(plan: ValidatedPlan, inputRoot: string): Promise<void> {
  for (const skill of plan.request.skills) {
    for (const file of skill.files) {
      await readAndHashSecure(joinContained(inputRoot, [skill.id, ...file.path.split('/')]), file, 'input');
    }
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

async function copyFileSecure(sourcePath: string, destinationPath: string, expected: MaterializeFile): Promise<void> {
  const sourceBefore = await bigintSnapshot(sourcePath);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const source = await fs.open(
    sourcePath,
    fsConstants.O_RDONLY | noFollow | (fsConstants.O_NONBLOCK ?? 0),
  );
  let destination;
  try {
    const sourceStat = await source.stat({ bigint: true });
    const openedSource: FileSnapshot = {
      dev: sourceStat.dev,
      ino: sourceStat.ino,
      size: sourceStat.size,
      mode: Number(sourceStat.mode & 0o7777n),
      nlink: sourceStat.nlink,
      mtimeNs: sourceStat.mtimeNs,
      ctimeNs: sourceStat.ctimeNs,
    };
    if (!sourceStat.isFile() || openedSource.nlink !== 1n || !sameIdentity(sourceBefore, openedSource)) {
      integrityError('Input file changed before copy');
    }
    await assertOpenedPathBinding(sourcePath, openedSource, inputError);
    if (openedSource.size !== BigInt(expected.size) || openedSource.mode !== expectedMode(expected)) {
      integrityError('Input metadata changed before copy');
    }

    destination = await fs.open(
      destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      expectedMode(expected),
    );
    const destinationOpenedStat = await destination.stat({ bigint: true });
    const openedDestination: FileSnapshot = {
      dev: destinationOpenedStat.dev,
      ino: destinationOpenedStat.ino,
      size: destinationOpenedStat.size,
      mode: Number(destinationOpenedStat.mode & 0o7777n),
      nlink: destinationOpenedStat.nlink,
      mtimeNs: destinationOpenedStat.mtimeNs,
      ctimeNs: destinationOpenedStat.ctimeNs,
    };
    if (!destinationOpenedStat.isFile() || openedDestination.nlink !== 1n || openedDestination.size !== 0n) {
      integrityError('Fresh output path did not create a private regular file');
    }
    await assertOpenedPathBinding(destinationPath, openedDestination, integrityError);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await destination.write(buffer, offset, bytesRead - offset, null);
        if (bytesWritten <= 0) throw new Error('Destination write made no progress');
        offset += bytesWritten;
      }
    }

    const sourceAfterStat = await source.stat({ bigint: true });
    const sourceAfter: FileSnapshot = {
      dev: sourceAfterStat.dev,
      ino: sourceAfterStat.ino,
      size: sourceAfterStat.size,
      mode: Number(sourceAfterStat.mode & 0o7777n),
      nlink: sourceAfterStat.nlink,
      mtimeNs: sourceAfterStat.mtimeNs,
      ctimeNs: sourceAfterStat.ctimeNs,
    };
    if (!sourceAfterStat.isFile() || !sameStableFile(openedSource, sourceAfter)) {
      integrityError('Input file changed during copy');
    }
    if (bytes !== expected.size || hash.digest('hex') !== expected.sha256) {
      integrityError('Copied input bytes do not match the request');
    }

    await destination.chmod(expectedMode(expected));
    const destinationStat = await destination.stat({ bigint: true });
    if (!destinationStat.isFile() || destinationStat.nlink !== 1n
      || destinationStat.size !== BigInt(expected.size)
      || Number(destinationStat.mode & 0o7777n) !== expectedMode(expected)) {
      integrityError('Output metadata does not match the request');
    }
    await destination.sync();
  } finally {
    await destination?.close();
    await source.close();
  }
}

async function createOutputTree(plan: ValidatedPlan, inputRoot: string, outputRoot: string): Promise<void> {
  const createDirectory = async (directory: string): Promise<void> => {
    const parent = path.dirname(directory);
    if (await fs.realpath(parent) !== path.resolve(parent)) {
      integrityError('Output directory parent is reached through a symbolic link');
    }
    await fs.mkdir(directory, { mode: 0o755 });
    await fs.chmod(directory, 0o755);
    const stat = await fs.lstat(directory, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()
      || Number(stat.mode & 0o7777n) !== 0o755
      || await fs.realpath(directory) !== path.resolve(directory)) {
      integrityError('Fresh output directory is not bound to the requested path');
    }
    await syncDirectory(parent);
  };

  try {
    await createDirectory(outputRoot);
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) {
      throw new MaterializeError('MATERIALIZE_OUTPUT_EXISTS', 'Output root already exists');
    }
    throw error;
  }

  for (const skill of plan.request.skills) {
    const outputSkill = joinContained(outputRoot, [skill.id]);
    await createDirectory(outputSkill);
    const directories = [...(plan.expectedDirectories.get(skill.id) ?? [])]
      .sort((left, right) => left.split('/').length - right.split('/').length || compareUtf8(left, right));
    for (const directory of directories) {
      await createDirectory(joinContained(outputSkill, directory.split('/')));
    }
    for (const file of skill.files) {
      const source = joinContained(inputRoot, [skill.id, ...file.path.split('/')]);
      const destination = joinContained(outputRoot, [skill.id, ...file.path.split('/')]);
      await copyFileSecure(source, destination, file);
      await syncDirectory(path.dirname(destination));
    }
  }
  await syncDirectory(outputRoot);
}

async function validateOutput(plan: ValidatedPlan, outputRoot: string): Promise<void> {
  const outputNames = await listDirectoryNames(outputRoot, plan.limits.maxSkills);
  if (!sameStrings(outputNames, plan.request.skills.map((skill) => skill.id))) {
    integrityError('Output root contains undeclared entries');
  }
  const budget: TreeScanBudget = { files: 0, directories: 0 };
  for (const skill of plan.request.skills) {
    const skillRoot = joinContained(outputRoot, [skill.id]);
    const scanned = await scanSkillTree(skillRoot, plan.limits, budget, 'output');
    if (!sameStrings(scanned.files, skill.files.map((file) => file.path))
      || !sameStrings(scanned.directories, plan.expectedDirectories.get(skill.id) ?? [])) {
      integrityError('Output tree does not exactly match the request');
    }
    for (const file of skill.files) {
      await readAndHashSecure(
        joinContained(outputRoot, [skill.id, ...file.path.split('/')]),
        file,
        'output',
      );
    }
  }
}

function cloneSkills(skills: MaterializeSkill[]): MaterializeSkill[] {
  return skills.map((skill) => ({
    id: skill.id,
    files: skill.files.map((file) => ({ ...file })),
  }));
}

/**
 * Copy the exhaustive, declared Skill tree into a fresh output root.
 *
 * This function is deliberately offline: it imports no TeamAI config, Git,
 * hooks, providers, or network modules. The caller must place both roots in a
 * private sandbox and prevent concurrent namespace mutation; portable Node.js
 * has no openat2/dirfd-relative API that can enforce that boundary by itself.
 */
export async function materializeSkills(
  value: MaterializeRequest,
  options: MaterializeOptions,
): Promise<MaterializeResult> {
  try {
    const plan = validateMaterializePlan(value, options.limits);
    const inputRoot = await requireDirectory(path.resolve(options.inputRoot), 'Input root');
    const outputRoot = await resolveFreshOutput(inputRoot, options.outputRoot);

    await validateInputLayout(plan, inputRoot);
    await validateInputFiles(plan, inputRoot);
    await createOutputTree(plan, inputRoot, outputRoot);
    await validateOutput(plan, outputRoot);

    const skills = cloneSkills(plan.request.skills);
    const resultPayload = {
      schema: MATERIALIZE_RESULT_SCHEMA,
      status: 'succeeded' as const,
      operation: MATERIALIZE_OPERATION,
      target: { ...plan.request.target },
      requestSha256: requestSha256(plan.request),
      outputSha256: canonicalSha256({ schema: 'teamai.materialize.output/v1', skills }),
      skills,
    };
    return {
      ...resultPayload,
      resultSha256: canonicalSha256(resultPayload),
    };
  } catch (error) {
    throw asMaterializeError(error);
  }
}
