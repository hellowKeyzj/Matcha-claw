import {
  binaryName,
  firstPositional,
  optionValue,
  positionalArgs,
  splitShellWords,
  splitTopLevelPipes,
  splitTopLevelStages,
  stripShellPreamble,
  trimLeadingEnv,
  unwrapShellWrapper,
} from './tool-display-exec-shell';

type ArgsRecord = Record<string, unknown>;

function asRecord(args: unknown): ArgsRecord | undefined {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? args as ArgsRecord
    : undefined;
}

function summarizeKnownExec(words: string[]): string {
  if (words.length === 0) {
    return '执行命令';
  }

  const bin = binaryName(words[0]) ?? 'command';

  if (bin === 'git') {
    const globalWithValue = new Set([
      '-C',
      '-c',
      '--git-dir',
      '--work-tree',
      '--namespace',
      '--config-env',
    ]);

    const gitCwd = optionValue(words, ['-C']);

    let sub: string | undefined;
    for (let index = 1; index < words.length; index += 1) {
      const token = words[index];
      if (!token) {
        continue;
      }
      if (token === '--') {
        sub = firstPositional(words, index + 1);
        break;
      }
      if (token.startsWith('--')) {
        if (token.includes('=')) {
          continue;
        }
        if (globalWithValue.has(token)) {
          index += 1;
        }
        continue;
      }
      if (token.startsWith('-')) {
        if (globalWithValue.has(token)) {
          index += 1;
        }
        continue;
      }
      sub = token;
      break;
    }

    const map: Record<string, string> = {
      status: '检查 Git 状态',
      diff: '查看 Git 差异',
      log: '查看 Git 历史',
      show: '显示 Git 对象',
      branch: '列出 Git 分支',
      checkout: '切换 Git 分支',
      switch: '切换 Git 分支',
      commit: '创建 Git 提交',
      pull: '拉取 Git 更新',
      push: '推送 Git 更新',
      fetch: '获取 Git 更新',
      merge: '合并 Git 更新',
      rebase: '变基 Git 分支',
      add: '暂存 Git 变更',
      restore: '恢复 Git 文件',
      reset: '重置 Git 状态',
      stash: '暂存 Git 变更',
    };

    if (sub && map[sub]) {
      return map[sub];
    }
    if (!sub || sub.startsWith('/') || sub.startsWith('~') || sub.includes('/')) {
      return gitCwd ? `执行 Git 命令 · ${gitCwd}` : '执行 Git 命令';
    }
    return `执行 git ${sub}`;
  }

  if (bin === 'grep' || bin === 'rg' || bin === 'ripgrep') {
    const positional = positionalArgs(words, 1, [
      '-e',
      '--regexp',
      '-f',
      '--file',
      '-m',
      '--max-count',
      '-A',
      '--after-context',
      '-B',
      '--before-context',
      '-C',
      '--context',
    ]);
    const pattern = optionValue(words, ['-e', '--regexp']) ?? positional[0];
    const target = positional.length > 1 ? positional.at(-1) : undefined;
    if (pattern) {
      return target ? `搜索“${pattern}” · ${target}` : `搜索“${pattern}”`;
    }
    return '搜索文本';
  }

  if (bin === 'find') {
    const path = words[1] && !words[1].startsWith('-') ? words[1] : '.';
    const name = optionValue(words, ['-name', '-iname']);
    return name ? `查找文件“${name}” · ${path}` : `查找文件 · ${path}`;
  }

  if (bin === 'ls') {
    const target = firstPositional(words, 1);
    return target ? `列出文件 · ${target}` : '列出文件';
  }

  if (bin === 'head' || bin === 'tail') {
    const lines =
      optionValue(words, ['-n', '--lines']) ??
      words
        .slice(1)
        .find((token) => /^-\d+$/.test(token))
        ?.slice(1);
    const positional = positionalArgs(words, 1, ['-n', '--lines']);
    let target = positional.at(-1);
    if (target && /^\d+$/.test(target) && positional.length === 1) {
      target = undefined;
    }
    const side = bin === 'head' ? '前' : '后';
    if (lines && target) {
      return `查看${side} ${lines} 行 · ${target}`;
    }
    if (lines) {
      return `查看${side} ${lines} 行`;
    }
    if (target) {
      return `查看 ${target}`;
    }
    return '查看输出';
  }

  if (bin === 'cat') {
    const target = firstPositional(words, 1);
    return target ? `查看 ${target}` : '查看输出';
  }

  if (bin === 'sed') {
    const expression = optionValue(words, ['-e', '--expression']);
    const positional = positionalArgs(words, 1, ['-e', '--expression', '-f', '--file']);
    const script = expression ?? positional[0];
    const target = expression ? positional[0] : positional[1];

    if (script) {
      const compact = script.replace(/\s+/g, '');
      const range = compact.match(/^([0-9]+),([0-9]+)p$/);
      if (range) {
        return target
          ? `打印 ${range[1]}-${range[2]} 行 · ${target}`
          : `打印 ${range[1]}-${range[2]} 行`;
      }
      const single = compact.match(/^([0-9]+)p$/);
      if (single) {
        return target ? `打印第 ${single[1]} 行 · ${target}` : `打印第 ${single[1]} 行`;
      }
    }

    return target ? `执行 sed · ${target}` : '执行 sed';
  }

  if (bin === 'printf' || bin === 'echo') {
    return '输出文本';
  }

  if (bin === 'cp' || bin === 'mv') {
    const positional = positionalArgs(words, 1, ['-t', '--target-directory', '-S', '--suffix']);
    const src = positional[0];
    const dst = positional[1];
    const action = bin === 'cp' ? '复制' : '移动';
    if (src && dst) {
      return `${action} ${src} → ${dst}`;
    }
    if (src) {
      return `${action} ${src}`;
    }
    return `${action}文件`;
  }

  if (bin === 'rm') {
    const target = firstPositional(words, 1);
    return target ? `删除 ${target}` : '删除文件';
  }

  if (bin === 'mkdir') {
    const target = firstPositional(words, 1);
    return target ? `创建目录 ${target}` : '创建目录';
  }

  if (bin === 'touch') {
    const target = firstPositional(words, 1);
    return target ? `创建文件 ${target}` : '创建文件';
  }

  if (bin === 'curl' || bin === 'wget') {
    const url = words.find((token) => /^https?:\/\//i.test(token));
    return url ? `抓取 ${url}` : '抓取 URL';
  }

  if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn' || bin === 'bun') {
    const positional = positionalArgs(words, 1, ['--prefix', '-C', '--cwd', '--config']);
    const sub = positional[0] ?? 'command';
    const map: Record<string, string> = {
      install: '安装依赖',
      test: '运行测试',
      build: '执行构建',
      start: '启动应用',
      lint: '运行检查',
      run: positional[1] ? `执行 ${positional[1]}` : '执行脚本',
    };
    return map[sub] ?? `执行 ${bin} ${sub}`;
  }

  if (bin === 'node' || bin === 'python' || bin === 'python3' || bin === 'ruby' || bin === 'php') {
    const heredoc = words.slice(1).find((token) => token.startsWith('<<'));
    if (heredoc) {
      return `执行 ${bin} 内联脚本`;
    }

    const inline =
      bin === 'node'
        ? optionValue(words, ['-e', '--eval'])
        : bin === 'python' || bin === 'python3'
          ? optionValue(words, ['-c'])
          : undefined;
    if (inline !== undefined) {
      return `执行 ${bin} 内联脚本`;
    }

    const nodeOptions = ['-e', '--eval', '-m'];
    const otherOptions = ['-c', '-e', '--eval', '-m'];
    const script = firstPositional(
      words,
      1,
      bin === 'node' ? nodeOptions : otherOptions,
    );
    if (!script) {
      return `执行 ${bin}`;
    }

    if (bin === 'node') {
      const mode =
        words.includes('--check') || words.includes('-c')
          ? '检查 JS 语法'
          : '执行 Node 脚本';
      return `${mode} · ${script}`;
    }

    return `执行 ${bin} · ${script}`;
  }

  if (bin === 'openclaw') {
    const sub = firstPositional(words, 1);
    return sub ? `执行 openclaw ${sub}` : '执行 openclaw';
  }

  const arg = firstPositional(words, 1);
  if (!arg || arg.length > 48) {
    return `执行 ${bin}`;
  }
  return /^[A-Za-z0-9._/-]+$/.test(arg) ? `执行 ${bin} ${arg}` : `执行 ${bin}`;
}

function summarizePipeline(stage: string): string {
  const pipeline = splitTopLevelPipes(stage);
  if (pipeline.length > 1) {
    const first = summarizeKnownExec(trimLeadingEnv(splitShellWords(pipeline[0])));
    const last = summarizeKnownExec(trimLeadingEnv(splitShellWords(pipeline[pipeline.length - 1])));
    const extra = pipeline.length > 2 ? `（另 ${pipeline.length - 2} 步）` : '';
    return `${first} -> ${last}${extra}`;
  }
  return summarizeKnownExec(trimLeadingEnv(splitShellWords(stage)));
}

type ExecSummary = {
  text: string;
  chdirPath?: string;
  allGeneric?: boolean;
};

function summarizeExecCommand(command: string): ExecSummary | undefined {
  const { command: cleaned, chdirPath } = stripShellPreamble(command);
  if (!cleaned) {
    return chdirPath ? { text: '', chdirPath } : undefined;
  }

  const stages = splitTopLevelStages(cleaned);
  if (stages.length === 0) {
    return undefined;
  }

  const summaries = stages.map((stage) => summarizePipeline(stage));
  const text = summaries.length === 1 ? summaries[0] : summaries.join(' → ');
  const allGeneric = summaries.every((summary) => isGenericSummary(summary));

  return { text, chdirPath, allGeneric };
}

const KNOWN_SUMMARY_PREFIXES = [
  '检查 Git',
  '查看 Git',
  '显示 Git',
  '列出 Git',
  '切换 Git',
  '创建 Git',
  '拉取 Git',
  '推送 Git',
  '获取 Git',
  '合并 Git',
  '变基 Git',
  '暂存 Git',
  '恢复 Git',
  '重置 Git',
  '搜索',
  '查找文件',
  '列出文件',
  '查看前',
  '查看后',
  '打印',
  '输出文本',
  '复制',
  '移动',
  '删除',
  '创建目录',
  '创建文件',
  '抓取',
  '安装依赖',
  '运行测试',
  '执行构建',
  '启动应用',
  '运行检查',
  '执行 openclaw',
  '执行 Node 脚本',
  '执行 python',
  '执行 ruby',
  '执行 php',
  '执行 sed',
  '检查 JS 语法',
];

function isGenericSummary(summary: string): boolean {
  if (summary === '执行命令') {
    return true;
  }
  if (summary.startsWith('执行 ')) {
    return !KNOWN_SUMMARY_PREFIXES.some((prefix) => summary.startsWith(prefix));
  }
  return false;
}

function compactRawCommand(raw: string, maxLength = 120): string {
  const oneLine = raw
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (oneLine.length <= maxLength) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function resolveExecDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const raw = typeof record.command === 'string' ? record.command.trim() : undefined;
  if (!raw) {
    return undefined;
  }

  const unwrapped = unwrapShellWrapper(raw);
  const result = summarizeExecCommand(unwrapped) ?? summarizeExecCommand(raw);
  const summary = result?.text || '执行命令';

  const cwdRaw =
    typeof record.workdir === 'string'
      ? record.workdir
      : typeof record.cwd === 'string'
        ? record.cwd
        : undefined;
  const cwd = cwdRaw?.trim() || result?.chdirPath || undefined;

  const compact = compactRawCommand(unwrapped);
  if (result?.allGeneric !== false && isGenericSummary(summary)) {
    return cwd ? `${compact} · ${cwd}` : compact;
  }

  return cwd ? `${summary} · ${cwd}` : summary;
}
