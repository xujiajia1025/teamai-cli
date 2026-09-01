import { Command, CommanderError } from 'commander';
import { createRequire } from 'node:module';
import { runMaterializeCli } from './materialize-cmd.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');
const program = new Command();

program
  .name('teamai-materialize')
  .description('Offline, deterministic TeamAI Skill materializer')
  .version(version)
  .requiredOption('--request <file>', 'Strict teamai.materialize.request/v1 JSON file')
  .requiredOption('--input-root <dir>', 'Private read-only Skill input root')
  .requiredOption('--output-root <dir>', 'Fresh output root to create')
  .requiredOption('--result <file>', 'Fresh machine-readable result file to create')
  .configureOutput({ writeErr: () => undefined })
  .exitOverride()
  .action(async (options: {
    request: string;
    inputRoot: string;
    outputRoot: string;
    result: string;
  }) => {
    process.exitCode = await runMaterializeCli(options);
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : 2;
    if (process.exitCode !== 0) {
      process.stderr.write('{"error":{"code":"MATERIALIZE_INVALID_REQUEST","message":"Invalid materialize CLI arguments"},"schema":"teamai.materialize.result/v1","status":"failed"}\n');
    }
  } else {
    process.stderr.write('{"error":{"code":"MATERIALIZE_INTERNAL_ERROR","message":"Materialize CLI failed"},"schema":"teamai.materialize.result/v1","status":"failed"}\n');
    process.exitCode = 70;
  }
}
