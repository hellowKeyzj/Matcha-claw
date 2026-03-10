export interface ChecklistItem {
  id: string;
  checked: boolean;
  text: string;
  children: ChecklistItem[];
  notes: string[];
  completionNote?: string;
  completionDetails: string[];
  evidenceDetails: string[];
}

export interface ProgressCounter {
  done: number;
  total: number;
}

export type StepDetailRow =
  | {
      id: string;
      type: 'item';
      depth: number;
      text: string;
      done: number;
      total: number;
      percent: number;
    }
  | {
      id: string;
      type: 'note';
      depth: number;
      text: string;
      checked: boolean;
    }
  | {
      id: string;
      type: 'completion';
      depth: number;
      text: string;
      details: string[];
    }
  | {
      id: string;
      type: 'evidence';
      depth: number;
      details: string[];
    };

function normalizeInlineMarkdown(text: string): string {
  return text
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/^>\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseChecklist(markdown: string): ChecklistItem[] {
  const lines = markdown.split(/\r?\n/);
  const steps: ChecklistItem[] = [];
  const stack: Array<{ indent: number; item: ChecklistItem }> = [];
  let inCodeFence = false;
  let currentItem: ChecklistItem | null = null;
  let sectionMode: 'none' | 'completion' | 'evidence' = 'none';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }

    const matched = line.match(/^(\s*)-\s+\[([ xX])\]\s+(.*)$/);
    if (matched) {
      const indent = matched[1].replace(/\t/g, '    ').length;
      const item: ChecklistItem = {
        id: `step-${index}-${indent}`,
        checked: matched[2].toLowerCase() === 'x',
        text: normalizeInlineMarkdown(matched[3]),
        children: [],
        notes: [],
        completionDetails: [],
        evidenceDetails: [],
      };

      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }

      if (stack.length === 0) {
        steps.push(item);
      } else {
        stack[stack.length - 1].item.children.push(item);
      }

      stack.push({ indent, item });
      currentItem = item;
      sectionMode = 'none';
      continue;
    }

    if (!currentItem) {
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/.test(trimmed)) {
      continue;
    }

    const normalized = normalizeInlineMarkdown(trimmed.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, ''));
    if (!normalized) {
      continue;
    }

    const completionMatch = normalized.match(/^完成情况[:：]\s*(.*)$/);
    if (completionMatch) {
      const noteText = completionMatch[1].trim();
      currentItem.completionNote = noteText || undefined;
      sectionMode = 'completion';
      continue;
    }

    const evidenceMatch = normalized.match(/^证据[:：]\s*(.*)$/);
    if (evidenceMatch) {
      const evidenceText = evidenceMatch[1].trim();
      if (evidenceText) {
        currentItem.evidenceDetails.push(evidenceText);
      }
      sectionMode = 'evidence';
      continue;
    }

    if (sectionMode === 'completion') {
      currentItem.completionDetails.push(normalized);
      continue;
    }

    if (sectionMode === 'evidence') {
      currentItem.evidenceDetails.push(normalized);
      continue;
    }

    currentItem.notes.push(normalized);
  }

  return steps;
}

export function countProgress(item: ChecklistItem): ProgressCounter {
  if (item.children.length === 0) {
    if (item.notes.length > 0) {
      return {
        done: item.checked ? item.notes.length : 0,
        total: item.notes.length,
      };
    }
    return {
      done: item.checked ? 1 : 0,
      total: 1,
    };
  }
  return item.children.reduce<ProgressCounter>(
    (acc, child) => {
      const childCounter = countProgress(child);
      return {
        done: acc.done + childCounter.done,
        total: acc.total + childCounter.total,
      };
    },
    { done: 0, total: 0 },
  );
}

export function buildStepDetailRows(step: ChecklistItem, depth = 0): StepDetailRow[] {
  const rows: StepDetailRow[] = [];

  step.notes.forEach((note, noteIndex) => {
    rows.push({
      id: `${step.id}-note-${noteIndex}`,
      type: 'note',
      depth,
      text: note,
      checked: step.checked,
    });
  });

  if (step.completionNote || step.completionDetails.length > 0) {
    rows.push({
      id: `${step.id}-completion`,
      type: 'completion',
      depth,
      text: step.completionNote ?? '',
      details: step.completionDetails,
    });
  }

  if (step.evidenceDetails.length > 0) {
    rows.push({
      id: `${step.id}-evidence`,
      type: 'evidence',
      depth,
      details: step.evidenceDetails,
    });
  }

  step.children.forEach((child) => {
    const progress = countProgress(child);
    const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
    rows.push({
      id: child.id,
      type: 'item',
      depth,
      text: child.text,
      done: progress.done,
      total: progress.total,
      percent,
    });
    rows.push(...buildStepDetailRows(child, depth + 1));
  });

  return rows;
}
