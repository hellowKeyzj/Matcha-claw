import { packToFile } from '../sdk/app-plugins/tooling/pack.mjs';

const usage = 'Usage: node scripts/pack-app-plugin.mjs <built-directory> <output.zip>';
const [directory, output, ...extra] = process.argv.slice(2);
try {
  if (directory === '--help' && !output) console.log(usage);
  else {
    if (!directory || !output || extra.length) throw new Error(usage);
    console.log(JSON.stringify(await packToFile(directory, output)));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
