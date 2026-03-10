import { SUBAGENT_TARGET_FILES } from '@/constants/subagent-files';
import type {
  DraftByFile,
  SubagentDraftFile,
  SubagentDraftRoleMetadata,
  SubagentTargetFile,
} from '@/types/subagent';

const FILE_RESPONSIBILITIES: Record<SubagentTargetFile, string> = {
  'AGENTS.md': '总体行为规则、流程和执行约束',
  'SOUL.md': '人格、语气、价值取向与互动风格',
  'TOOLS.md': '工具使用策略、授权边界和调用偏好',
  'IDENTITY.md': '身份、角色、名称和人设定义',
  'USER.md': '用户偏好、沟通习惯和个性化约定',
};

interface PromptPayload {
  systemPrompt: string;
  userPrompt: string;
}

interface RawDraftItem {
  name?: unknown;
  content?: unknown;
  reason?: unknown;
  confidence?: unknown;
}

interface RawDraftOutput {
  files?: unknown;
  roleMetadata?: unknown;
}

interface RawRoleMetadata {
  summary?: unknown;
  tags?: unknown;
}

export interface ParsedSubagentDraft {
  draftByFile: DraftByFile;
  roleMetadata: SubagentDraftRoleMetadata;
}

const MANDATORY_ITERATION_INSTRUCTIONS = [
  '始终在同一会话中，基于上一版草稿继续迭代优化。',
  '如果还没有上一版草稿，则从零开始生成初稿。',
  '将用户输入视为“增量修改指令”（说明改哪些文件、改什么）。',
  '当用户只要求优化部分文件时，未指定文件保持不变。',
  '尽量增量改写：保留已有优点，只重写薄弱部分。',
  '每轮都检查 AGENTS.md / SOUL.md / TOOLS.md / IDENTITY.md / USER.md 的一致性。',
  '优先使用具体、可执行的表述，避免空泛语句。',
  '输出前自检：完整性、一致性、清晰度、可执行性。',
  '输出格式必须始终为 JSON：{"files":[{"name","content","reason","confidence"}],"roleMetadata":{"summary","tags"}}。',
  '每个文件项必须包含：name、content、reason、confidence。',
  'roleMetadata.summary 必填，用 120-300 字概括该 agent 的职责边界与擅长任务。',
  'roleMetadata.tags 必填，提供 3-8 个短标签数组。',
  'confidence 必须是 [0,1] 区间内的数字。',
  'content 字段内禁止出现未转义的双引号；如必须使用双引号，写成 \\\\"。',
  'content 字段禁止使用三反引号代码块（```）；如需示例，请改为普通文本或缩进文本。',
  '每个 content 优先简洁、可执行，不写冗长说明。',
  '输出前必须自检 JSON 可被 JSON.parse 成功解析；若失败，先修复再输出。',
  '只返回 JSON，不要返回 Markdown 代码块或额外解释文本。',
].join('\n');

const MAX_BASELINE_FILE_CHARS = 6000;

function tryParseJsonObject(text: string): RawDraftOutput | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }
    return parsed as RawDraftOutput;
  } catch {
    return undefined;
  }
}

function extractBalancedObject(text: string, startIndex: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === '\\') {
        escaping = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }

  return undefined;
}

function parseModelDraftOutput(output: string): RawDraftOutput | undefined {
  const direct = tryParseJsonObject(output);
  if (direct) {
    return direct;
  }

  const fencedBlocks = output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const block of fencedBlocks) {
    const parsed = tryParseJsonObject((block[1] ?? '').trim());
    if (parsed) {
      return parsed;
    }
  }

  const filesObjectPattern = /\{\s*"files"\s*:/g;
  for (const match of output.matchAll(filesObjectPattern)) {
    const start = match.index;
    if (start == null) {
      continue;
    }
    const candidate = extractBalancedObject(output, start);
    if (!candidate) {
      continue;
    }
    const parsed = tryParseJsonObject(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function trimBaselineContent(content: string): string {
  if (content.length <= MAX_BASELINE_FILE_CHARS) {
    return content;
  }
  const headSize = Math.floor(MAX_BASELINE_FILE_CHARS * 0.75);
  const tailSize = MAX_BASELINE_FILE_CHARS - headSize;
  const head = content.slice(0, headSize);
  const tail = content.slice(content.length - tailSize);
  return `${head}\n\n[...已截断，保留开头与结尾...]\n\n${tail}`;
}

function hasPersistedBaselineSnapshot(
  persistedFilesByName: Partial<Record<SubagentTargetFile, string>>,
): boolean {
  return SUBAGENT_TARGET_FILES.some((name) =>
    Object.prototype.hasOwnProperty.call(persistedFilesByName, name));
}

function buildPersistedBaselineSection(
  persistedFilesByName: Partial<Record<SubagentTargetFile, string>>,
): string | undefined {
  if (!hasPersistedBaselineSnapshot(persistedFilesByName)) {
    return undefined;
  }
  const sections: string[] = ['当前已落盘文件内容（作为本轮基线）:'];
  for (const fileName of SUBAGENT_TARGET_FILES) {
    const raw = persistedFilesByName[fileName] ?? '';
    const normalized = trimBaselineContent(raw);
    sections.push(`\n### ${fileName}`);
    sections.push('```md');
    sections.push(normalized || '(空)');
    sections.push('```');
  }
  return sections.join('\n');
}

export function buildSubagentPromptPayload(
  prompt: string,
  persistedFilesByName: Partial<Record<SubagentTargetFile, string>> = {},
): PromptPayload {
  const rules = SUBAGENT_TARGET_FILES
    .map((file) => `- ${file}: ${FILE_RESPONSIBILITIES[file]}`)
    .join('\n');
  const persistedBaseline = buildPersistedBaselineSection(persistedFilesByName);

  return {
    systemPrompt: [
      '你是配置拆分助手。',
      '仅可输出 5 个目标文件：AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md。',
      '严格返回 JSON：{"files":[{"name","content","reason","confidence"}],"roleMetadata":{"summary","tags"}}，不允许额外文本。',
      'confidence 必须在 0 到 1 之间。',
    ].join('\n'),
    userPrompt: [
      '迭代规则（系统自动附加）：',
      MANDATORY_ITERATION_INSTRUCTIONS,
      '',
      '请根据以下文件职责生成草稿：',
      rules,
      '',
      ...(persistedBaseline
        ? [persistedBaseline, '']
        : []),
      '用户提示词：',
      prompt.trim(),
    ].join('\n'),
  };
}

export function extractChatSendOutput(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }

  if (!result || typeof result !== 'object') {
    throw new Error('Missing model output text');
  }

  const candidate = result as Record<string, unknown>;
  const fields = ['output', 'message', 'text', 'response', 'content'];
  for (const field of fields) {
    const value = candidate[field];
    if (typeof value === 'string') {
      return value;
    }
  }

  throw new Error('Missing model output text');
}

export function parseDraftPayload(output: string): ParsedSubagentDraft {
  const parsed = parseModelDraftOutput(output);
  if (!parsed) {
    throw new Error('Invalid JSON output from model');
  }

  if (!Array.isArray(parsed.files)) {
    throw new Error('Invalid output schema: files must be an array');
  }

  const draftByFile: DraftByFile = {};
  for (const rawItem of parsed.files as RawDraftItem[]) {
    const name = rawItem.name;
    const content = rawItem.content;
    const reason = rawItem.reason;
    const confidence = rawItem.confidence;

    if (typeof name !== 'string') {
      throw new Error('Invalid output schema: name is required');
    }
    if (!SUBAGENT_TARGET_FILES.includes(name as SubagentTargetFile)) {
      throw new Error(`Unsupported target file: ${name}`);
    }
    if (typeof content !== 'string') {
      throw new Error(`Invalid output schema: content is required for ${name}`);
    }
    if (typeof reason !== 'string') {
      throw new Error(`Invalid output schema: reason is required for ${name}`);
    }
    if (typeof confidence !== 'number' || Number.isNaN(confidence)) {
      throw new Error(`Invalid output schema: confidence is required for ${name}`);
    }

    const normalized: SubagentDraftFile = {
      name: name as SubagentTargetFile,
      content,
      reason,
      confidence,
      needsReview: confidence < 0.6,
    };
    draftByFile[normalized.name] = normalized;
  }

  const rawRoleMetadata = parsed.roleMetadata;
  if (!rawRoleMetadata || typeof rawRoleMetadata !== 'object') {
    throw new Error('Invalid output schema: roleMetadata is required');
  }
  const roleMetadata = rawRoleMetadata as RawRoleMetadata;
  const summary = typeof roleMetadata.summary === 'string'
    ? roleMetadata.summary.trim()
    : '';
  if (!summary) {
    throw new Error('Invalid output schema: roleMetadata.summary is required');
  }
  if (summary.includes('```')) {
    throw new Error('Invalid output schema: roleMetadata.summary cannot contain code fences');
  }
  const tags = Array.isArray(roleMetadata.tags)
    ? roleMetadata.tags
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    : [];
  if (tags.length === 0) {
    throw new Error('Invalid output schema: roleMetadata.tags is required');
  }

  return {
    draftByFile,
    roleMetadata: {
      summary,
      tags: Array.from(new Set(tags)).slice(0, 8),
    },
  };
}

export function parseDraftByFile(output: string): DraftByFile {
  const parsed = parseDraftPayload(output);
  return parsed.draftByFile;
}
