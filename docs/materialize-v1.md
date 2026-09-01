# Offline materialization protocol v1

`teamai materialize` is a deterministic, offline Skill-copying contract for orchestrators. It does not initialize TeamAI, discover local configuration, refresh Git repositories, install hooks, update MCP settings, read credentials, contact a network service, or write into an AI tool directory.

The smaller `teamai-materialize` executable is the normative machine interface. Its published `dist/materialize-bin.js` is a single ESM bundle: its parser, schema validator, TeamAI license, and bundled-dependency notices are embedded, and its only runtime imports are Node.js built-ins, so it does not require `node_modules`. The main `teamai materialize` command is a convenience wrapper over the same engine, but it retains TeamAI's general help and argument-parser behavior. Orchestrators that require the JSON diagnostic and exit-code contract below must invoke `teamai-materialize`.

## Invocation

```bash
teamai-materialize \
  --request /sandbox/request.json \
  --input-root /sandbox/input \
  --output-root /sandbox/output \
  --result /sandbox/result.json
```

All four paths are supplied by the caller and are not accepted from request JSON. The request and input root must already exist. The output root and result file must not exist. Request, input, output, and result paths must not overlap.

The caller must run the process inside a private filesystem sandbox with no concurrent namespace mutator. The input tree and the output/result parents must not contain attacker-controlled nested mount points, bind mounts, FUSE mounts, or reparse mounts; construct input by copying verified regular files into the sandbox instead of mounting an external tree. The materializer contains no network or child-process code, but application-level isolation is not a replacement for an operating-system sandbox.

Protocol v1 is production-qualified on macOS and Linux with POSIX filesystem semantics. Paths are validated for Windows portability, but Windows ACL-to-mode mapping and directory durability have not yet been qualified. A production orchestrator must fail closed on Windows until that platform has dedicated conformance evidence.

## Request

```json
{
  "schema": "teamai.materialize.request/v1",
  "operation": "copy-skills",
  "target": {
    "id": "codex",
    "layout": "flat-skill-root/v1"
  },
  "skills": [
    {
      "id": "systematic-debugging",
      "files": [
        {
          "path": "SKILL.md",
          "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "size": 1234,
          "mode": "0644"
        },
        {
          "path": "find-polluter.sh",
          "sha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          "size": 4321,
          "mode": "0755"
        }
      ]
    }
  ]
}
```

Input is located implicitly at `<input-root>/<skill-id>/<file-path>`. Output uses the same flat Skill-root layout at `<output-root>/<skill-id>/<file-path>`. `target.id` is identity metadata; the materializer never chooses a real project path such as `.codex/skills` or `.agents/skills`.

The request is strict:

- unknown fields, duplicate JSON object keys, unsupported schema/operation/layout, duplicate entries, and non-canonical ordering are rejected;
- `target.id` and every Skill `id` must be 1-64 ASCII characters matching `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`;
- Skills and files must be sorted by their UTF-8 byte sequence and must be portable after case folding and Unicode NFC normalization;
- every Skill must exhaustively list its tree and include a regular `SKILL.md` file;
- paths must use `/`; every segment is at most 255 UTF-8 bytes and cannot contain absolute paths, empty/`.`/`..` segments, backslashes, control characters, Windows drive/UNC/alternate-stream syntax, reserved Windows names, or trailing dots/spaces;
- only regular directories and private regular files are accepted; symlinks, hard links, junction-like traversal, FIFOs, sockets, and devices are rejected;
- file modes are exactly `0644` or `0755`; content is copied byte-for-byte without frontmatter injection, newline conversion, filtering, parsing, or execution;
- every created output directory, including the output root, has mode `0755`;
- `skills: []` is valid only with an empty input root and produces a verified empty output root.

Default limits are 256 Skills, 8,192 files, 8,192 directories, 16 MiB per file, 256 MiB total content, 1,024 UTF-8 bytes per relative path, and 32 path segments. The JSON request limit is 4 MiB.

## Success result

Success exits with code `0`, leaves stdout empty, and creates the result file with mode `0600`:

```json
{
  "operation": "copy-skills",
  "outputSha256": "...",
  "requestSha256": "...",
  "resultSha256": "...",
  "schema": "teamai.materialize.result/v1",
  "skills": [],
  "status": "succeeded",
  "target": {
    "id": "codex",
    "layout": "flat-skill-root/v1"
  }
}
```

Arrays are stably ordered. The result contains no timestamp, PID, username, HOME, environment value, or absolute path. `requestSha256` hashes canonical request JSON. `outputSha256` hashes the declared Skill/file manifest. `resultSha256` hashes the canonical success result excluding `resultSha256` itself.

Hash preimages use compact canonical JSON: object keys are sorted by their UTF-8 byte sequence, arrays retain their required canonical order, integers use ECMAScript `JSON.stringify` serialization, and strings use ECMAScript `JSON.stringify` escaping encoded as UTF-8. No insignificant whitespace or trailing newline is included. In exact terms:

- `requestSha256 = SHA-256(canonical-json(request))`;
- `outputSha256 = SHA-256(canonical-json({"schema":"teamai.materialize.output/v1","skills":result.skills}))`;
- `resultSha256 = SHA-256(canonical-json(success-result-without-resultSha256))`.

All digests are lowercase hexadecimal SHA-256 strings. The newline used to terminate the result file is not part of any preimage.

The normative empty-Skill vector is:

```text
request preimage: {"operation":"copy-skills","schema":"teamai.materialize.request/v1","skills":[],"target":{"id":"codex","layout":"flat-skill-root/v1"}}
requestSha256: dada6529910cce5a440eab65b0c2ccb407825c8b3786101992d63cf37effffa3
output preimage: {"schema":"teamai.materialize.output/v1","skills":[]}
outputSha256: aa4288df4afde3f5c7d0826d6d66590db4d49ce35f0804ca5aa7e4795b577e6c
```

The calling orchestrator must still rescan output and independently verify every path, byte hash, size, and mode before publication. It should pin the exact TeamAI fork commit and the SHA-256 of the exact `dist/materialize-bin.js` bytes outside this protocol. If the artifact is copied outside the npm package, the caller must preserve ESM classification (for example, by naming the byte-identical copy with an `.mjs` suffix).

## Failure behavior

Any error invalidates the entire output root. Partial staging can remain for forensic inspection, but it must never be reused or published. TeamAI does not silently fall back to another renderer.

When the result path was validated and can be created, a failure result is written:

```json
{
  "error": {
    "code": "MATERIALIZE_INTEGRITY_MISMATCH",
    "message": "Input file hash does not match the request"
  },
  "schema": "teamai.materialize.result/v1",
  "status": "failed"
}
```

Diagnostics are a single bounded JSON line on stderr and do not contain sandbox paths. Stable exit classes are:

| Exit | Meaning |
|---|---|
| `0` | Complete verified success |
| `1` | I/O or unclassified materialization failure |
| `2` | Invalid request, unsafe path, ordering, or resource limit |
| `3` | Invalid input tree or integrity mismatch |
| `4` | Output or result already exists |
| `70` | Standalone CLI bootstrap failure |

If argument parsing fails, request/result topology is unsafe, or the result already exists, a result file might not be written. A non-zero process exit always remains authoritative.

## Explicit non-goals

Protocol v1 does not render Rules, Agents, Hooks, MCP, environment settings, Docs, sources, analytics, or built-in TeamAI content. It does not apply roles or tags and does not read `teamai.yaml`. Those features remain under the interactive `init`/`pull` workflow; adding any of them to materialization requires a new reviewed protocol version.
