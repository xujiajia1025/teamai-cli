import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const packageManifest = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig((overrideOptions) => ({
  // Production builds split the normative artifact into its own dependency-bundled
  // pass. Keep both entries available in the ordinary watcher for source development.
  entry: overrideOptions.watch ? ['src/index.ts', 'src/materialize-bin.ts'] : ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: !overrideOptions.watch,
  splitting: false,
  sourcemap: true,
  dts: false,
  define: {
    __TEAMAI_MATERIALIZE_VERSION__: JSON.stringify(packageManifest.version),
  },
  banner: {
    js: '#!/usr/bin/env node',
  },
}));
