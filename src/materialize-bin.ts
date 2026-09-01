import { runMaterializeCli, type MaterializeCliOptions } from './materialize-cmd.js';

declare const __TEAMAI_MATERIALIZE_VERSION__: string;

const INVALID_ARGUMENTS = '{"error":{"code":"MATERIALIZE_INVALID_REQUEST","message":"Invalid materialize CLI arguments"},"schema":"teamai.materialize.result/v1","status":"failed"}\n';
const INTERNAL_ERROR = '{"error":{"code":"MATERIALIZE_INTERNAL_ERROR","message":"Materialize CLI failed"},"schema":"teamai.materialize.result/v1","status":"failed"}\n';
const HELP = `Usage: teamai-materialize [options]

Offline, deterministic TeamAI Skill materializer

Options:
  --request <file>      Strict teamai.materialize.request/v1 JSON file
  --input-root <dir>    Private read-only Skill input root
  --output-root <dir>   Fresh output root to create
  --result <file>       Fresh machine-readable result file to create
  -V, --version         output the version number
  -h, --help            display help for command
`;

const OPTION_KEYS = new Map<keyof MaterializeCliOptions, keyof MaterializeCliOptions>([
  ['request', 'request'],
  ['inputRoot', 'inputRoot'],
  ['outputRoot', 'outputRoot'],
  ['result', 'result'],
]);

function camelCaseOption(option: string): keyof MaterializeCliOptions | undefined {
  const normalized = option.replace(/^--/, '').replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return OPTION_KEYS.get(normalized as keyof MaterializeCliOptions);
}

function parseArguments(argv: string[]): MaterializeCliOptions {
  const values: Partial<MaterializeCliOptions> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error('Unexpected positional argument');
    const separator = argument.indexOf('=');
    const option = separator === -1 ? argument : argument.slice(0, separator);
    const key = camelCaseOption(option);
    if (!key || values[key] !== undefined) throw new Error('Unknown or duplicate option');
    const value = separator === -1 ? argv[index + 1] : argument.slice(separator + 1);
    if (!value || (separator === -1 && value.startsWith('--'))) {
      throw new Error('Option requires a value');
    }
    values[key] = value;
    if (separator === -1) index += 1;
  }
  if (!values.request || !values.inputRoot || !values.outputRoot || !values.result) {
    throw new Error('Required option is missing');
  }
  return values as MaterializeCliOptions;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
    process.stdout.write(`${__TEAMAI_MATERIALIZE_VERSION__}\n`);
    return;
  }
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(HELP);
    return;
  }
  let options: MaterializeCliOptions;
  try {
    options = parseArguments(argv);
  } catch {
    process.stderr.write(INVALID_ARGUMENTS);
    process.exitCode = 2;
    return;
  }
  process.exitCode = await runMaterializeCli(options);
}

try {
  await main();
} catch {
  process.stderr.write(INTERNAL_ERROR);
  process.exitCode = 70;
}
