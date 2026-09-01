import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const packageManifest = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version?: unknown };
const projectLicense = readFileSync(new URL('./LICENSE', import.meta.url), 'utf8').trimEnd();
const thirdPartyNotices = readFileSync(
  new URL('./THIRD_PARTY_NOTICES.materialize.txt', import.meta.url),
  'utf8',
).trimEnd();

if (typeof packageManifest.version !== 'string' || packageManifest.version.length === 0) {
  throw new Error('package.json must declare a non-empty version');
}

export default defineConfig({
  entry: ['src/materialize-bin.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: false,
  splitting: false,
  sourcemap: true,
  metafile: true,
  dts: false,
  // The normative machine interface is distributed as one executable artifact.
  // Bundle every npm dependency; Node built-ins remain external for platform=node.
  noExternal: [/.*/],
  define: {
    __TEAMAI_MATERIALIZE_VERSION__: JSON.stringify(packageManifest.version),
  },
  banner: {
    // Keep all redistribution notices inside the byte-pinned single-file artifact.
    js: `#!/usr/bin/env node
/*!
${projectLicense}

${thirdPartyNotices}
*/`,
  },
});
