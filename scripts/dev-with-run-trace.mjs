import { spawnSync } from 'node:child_process';

const env = {
  ...process.env,
  MATCHA_AGENT_RUN_TRACE: '1',
};

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: true,
    env,
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run('pnpm', ['run', 'build:runtime-host-process']);
run('vite', []);
