export type LineDiffType = 'keep' | 'add' | 'remove';

export interface LineDiffEntry {
  type: LineDiffType;
  value: string;
}

function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }
  return text.split(/\r?\n/);
}

export function buildLineDiff(original: string, next: string): LineDiffEntry[] {
  const left = splitLines(original);
  const right = splitLines(next);
  const rows = left.length;
  const cols = right.length;

  const dp: number[][] = Array.from({ length: rows + 1 }, () =>
    Array<number>(cols + 1).fill(0)
  );

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      if (left[i] === right[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const result: LineDiffEntry[] = [];
  let i = 0;
  let j = 0;

  while (i < rows && j < cols) {
    if (left[i] === right[j]) {
      result.push({ type: 'keep', value: left[i] });
      i += 1;
      j += 1;
      continue;
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'remove', value: left[i] });
      i += 1;
    } else {
      result.push({ type: 'add', value: right[j] });
      j += 1;
    }
  }

  while (i < rows) {
    result.push({ type: 'remove', value: left[i] });
    i += 1;
  }

  while (j < cols) {
    result.push({ type: 'add', value: right[j] });
    j += 1;
  }

  return result;
}
