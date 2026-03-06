export interface MarkdownProgress {
  total: number;
  completed: number;
  progress: number;
}

const CHECKBOX_LINE = /^-\s+\[( |x|X)\]\s+/;

export function calculateMarkdownProgress(markdown: string): MarkdownProgress {
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let total = 0;
  let completed = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (!CHECKBOX_LINE.test(line)) {
      continue;
    }

    total += 1;
    if (line.startsWith("- [x]") || line.startsWith("- [X]")) {
      completed += 1;
    }
  }

  const progress = total > 0 ? completed / total : 0;
  return { total, completed, progress };
}

