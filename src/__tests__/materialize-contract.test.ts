import { describe, expect, it } from 'vitest';
import {
  MATERIALIZE_LAYOUT,
  MATERIALIZE_OPERATION,
  MATERIALIZE_REQUEST_SCHEMA,
  MaterializeError,
  canonicalJson,
  canonicalSha256,
  parseMaterializeRequest,
  requestSha256,
  type MaterializeRequest,
} from '../materialize/index.js';

const HASH = '0'.repeat(64);

function request(): MaterializeRequest {
  return {
    schema: MATERIALIZE_REQUEST_SCHEMA,
    operation: MATERIALIZE_OPERATION,
    target: { id: 'codex', layout: MATERIALIZE_LAYOUT },
    skills: [{
      id: 'example',
      files: [{ path: 'SKILL.md', sha256: HASH, size: 0, mode: '0644' }],
    }],
  };
}

function expectRequestError(run: () => unknown, code = 'MATERIALIZE_INVALID_REQUEST'): void {
  try {
    run();
    throw new Error('Expected request parsing to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(MaterializeError);
    expect((error as MaterializeError).code).toBe(code);
    expect((error as MaterializeError).exitCode).toBe(2);
  }
}

describe('materialize v1 request contract', () => {
  it('parses the strict v1 request', () => {
    expect(parseMaterializeRequest(JSON.stringify(request()))).toEqual(request());
  });

  it('rejects malformed JSON and oversized JSON with stable errors', () => {
    expectRequestError(() => parseMaterializeRequest('{'));
    expectRequestError(
      () => parseMaterializeRequest(JSON.stringify(request()), 8),
      'MATERIALIZE_LIMIT_EXCEEDED',
    );
  });

  it('rejects duplicate object keys, including escaped-equivalent keys', () => {
    const valid = JSON.stringify(request());
    expectRequestError(() => parseMaterializeRequest(valid.replace('{', '{"schema":"shadow",')));
    expectRequestError(() => parseMaterializeRequest(valid.replace('{', '{"sche\\u006da":"shadow",')));
  });

  it.each([
    ['unknown root field', { ...request(), unknown: true }],
    ['unknown target field', { ...request(), target: { ...request().target, unknown: true } }],
    ['unknown skill field', {
      ...request(),
      skills: [{ ...request().skills[0], unknown: true }],
    }],
    ['unknown file field', {
      ...request(),
      skills: [{
        ...request().skills[0],
        files: [{ ...request().skills[0].files[0], unknown: true }],
      }],
    }],
    ['unknown schema', { ...request(), schema: 'teamai.materialize.request/v2' }],
    ['unknown operation', { ...request(), operation: 'render-everything' }],
    ['unknown layout', { ...request(), target: { id: 'codex', layout: 'native' } }],
    ['uppercase hash', {
      ...request(),
      skills: [{
        ...request().skills[0],
        files: [{ ...request().skills[0].files[0], sha256: 'A'.repeat(64) }],
      }],
    }],
    ['numeric mode', {
      ...request(),
      skills: [{
        ...request().skills[0],
        files: [{ ...request().skills[0].files[0], mode: 0o644 }],
      }],
    }],
  ])('rejects %s', (_label, value) => {
    expectRequestError(() => parseMaterializeRequest(value));
  });

  it('accepts a governed request with zero Skills', () => {
    const empty = { ...request(), skills: [] };
    expect(parseMaterializeRequest(empty)).toEqual(empty);
  });

  it('keeps the normative empty-request hash vector stable', () => {
    const empty = { ...request(), skills: [] };
    const requestPreimage = '{"operation":"copy-skills","schema":"teamai.materialize.request/v1","skills":[],"target":{"id":"codex","layout":"flat-skill-root/v1"}}';
    expect(canonicalJson(empty)).toBe(requestPreimage);
    expect(requestSha256(empty)).toBe('dada6529910cce5a440eab65b0c2ccb407825c8b3786101992d63cf37effffa3');
    expect(canonicalSha256({ schema: 'teamai.materialize.output/v1', skills: [] }))
      .toBe('aa4288df4afde3f5c7d0826d6d66590db4d49ce35f0804ca5aa7e4795b577e6c');
  });
});
