export const MATERIALIZE_EXIT_CODE = {
  io: 1,
  request: 2,
  input: 3,
  conflict: 4,
} as const;

export type MaterializeErrorCode =
  | 'MATERIALIZE_INVALID_REQUEST'
  | 'MATERIALIZE_UNSAFE_PATH'
  | 'MATERIALIZE_LIMIT_EXCEEDED'
  | 'MATERIALIZE_INPUT_INVALID'
  | 'MATERIALIZE_INTEGRITY_MISMATCH'
  | 'MATERIALIZE_OUTPUT_EXISTS'
  | 'MATERIALIZE_IO_ERROR';

const EXIT_CODES: Record<MaterializeErrorCode, number> = {
  MATERIALIZE_INVALID_REQUEST: MATERIALIZE_EXIT_CODE.request,
  MATERIALIZE_UNSAFE_PATH: MATERIALIZE_EXIT_CODE.request,
  MATERIALIZE_LIMIT_EXCEEDED: MATERIALIZE_EXIT_CODE.request,
  MATERIALIZE_INPUT_INVALID: MATERIALIZE_EXIT_CODE.input,
  MATERIALIZE_INTEGRITY_MISMATCH: MATERIALIZE_EXIT_CODE.input,
  MATERIALIZE_OUTPUT_EXISTS: MATERIALIZE_EXIT_CODE.conflict,
  MATERIALIZE_IO_ERROR: MATERIALIZE_EXIT_CODE.io,
};

/** A stable, machine-readable error surfaced by the materialize v1 API. */
export class MaterializeError extends Error {
  readonly code: MaterializeErrorCode;
  readonly exitCode: number;

  constructor(code: MaterializeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MaterializeError';
    this.code = code;
    this.exitCode = EXIT_CODES[code];
  }
}

export function asMaterializeError(error: unknown, context = 'Materialization failed'): MaterializeError {
  if (error instanceof MaterializeError) return error;
  const cause = error instanceof Error ? error : undefined;
  return new MaterializeError('MATERIALIZE_IO_ERROR', context, { cause });
}
