import { SUBAGENT_TARGET_FILES } from '@/constants/subagent-files';
import type {
  DraftByFile,
  SubagentDraftFile,
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

interface BuildSubagentPromptPayloadOptions {
  includeCurrentFiles: boolean;
  persistedFilesByName?: Partial<Record<SubagentTargetFile, string>>;
}

interface RawDraftItem {
  name?: unknown;
  content?: unknown;
  reason?: unknown;
  confidence?: unknown;
}

interface RawDraftOutput {
  files?: unknown;
}

export interface ParsedSubagentDraft {
  draftByFile: DraftByFile;
}

const MANDATORY_DRAFT_INSTRUCTIONS = [
  '你正在生成目标工作区最终落盘的 5 个配置文件，不是在描述你自己的生成任务。',
  '外层生成器身份、JSON 规则、文件职责说明、草稿规则、用户提示词标签，只能用于理解任务，禁止写进任何 content。',
  '每个 content 都必须站在目标 Agent/工作区视角书写，围绕用户真正目标组织内容。',
  '同一草稿会话中的后续请求，必须基于上一版草稿继续迭代优化。',
  '如果本轮没有附加当前文件内容，则从空白模板生成初稿，不继承默认工作区模板。',
  '如果本轮附加了当前文件内容，则把它们作为本轮基线。',
  '只有当用户明确要求只修改部分文件时，未指定文件才保持不变。',
  '否则 5 个目标文件都必须围绕用户目标重新组织，不能保留与目标无关的旧内容。',
  '必须输出且仅输出 AGENTS.md、SOUL.md、TOOLS.md、IDENTITY.md、USER.md 五个文件，各出现一次。',
  '尽量增量改写：保留已有优点，只重写薄弱部分。',
  '每轮都检查 AGENTS.md / SOUL.md / TOOLS.md / IDENTITY.md / USER.md 的一致性。',
  '优先使用具体、可执行的表述，避免空泛语句。',
  '输出前自检：完整性、一致性、清晰度、可执行性、目标视角纯净度。',
  '输出格式必须始终为 JSON：{"files":[{"name","content","reason","confidence"}]}。',
  '每个文件项必须包含：name、content、reason、confidence。',
  'confidence 必须是 [0,1] 区间内的数字。',
  'content 字段内禁止出现未转义的双引号；如必须使用双引号，写成 \\\\"。',
  'content 字段禁止使用三反引号代码块（```）；如需示例，请改为普通文本或缩进文本。',
  '每个 content 优先简洁、可执行，不写冗长说明。',
  '输出前必须自检 JSON 可被 JSON.parse 成功解析；若失败，先修复再输出。',
  '只返回 JSON，不要返回 Markdown 代码块或额外解释文本。',
].join('\n');

const MAX_BASELINE_FILE_CHARS = 6000;
const DRAFT_OUTPUT_SCHEMA = '{"files":[{"name","content","reason","confidence"}]}';
const FORBIDDEN_CONTENT_TERMS = [
  '配置拆分助手',
  '目标文件',
  '文件职责',
  '草稿规则',
  '系统自动附加',
  '用户提示词',
  '输出 JSON',
  'JSON.parse',
  'confidence 必须',
  'content 字段',
  '只返回 JSON',
  '本轮没有附加当前文件内容',
  '本轮附加了当前文件内容',
];

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
  options: BuildSubagentPromptPayloadOptions = { includeCurrentFiles: false },
): PromptPayload {
  const rules = SUBAGENT_TARGET_FILES
    .map((file) => `- ${file}: ${FILE_RESPONSIBILITIES[file]}`)
    .join('\n');
  const persistedBaseline = options.includeCurrentFiles
    ? buildPersistedBaselineSection(options.persistedFilesByName ?? {})
    : undefined;

  return {
    systemPrompt: [
      '你是工作区配置文件生成器。',
      '你的任务是把用户目标转换成目标工作区的 5 个 Markdown 配置文件。',
      '你的生成器身份和这些输出规则不得出现在任何 content 字段中。',
      '严格返回 JSON：{"files":[{"name","content","reason","confidence"}]}，不允许额外文本。',
      'confidence 必须在 0 到 1 之间。',
    ].join('\n'),
    userPrompt: [
      '生成协议：',
      MANDATORY_DRAFT_INSTRUCTIONS,
      '',
      '目标文件职责：',
      rules,
      '',
      ...(persistedBaseline
        ? [persistedBaseline, '']
        : []),
      '用户真正目标：',
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
  const seenFiles = new Set<SubagentTargetFile>();
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
    if (seenFiles.has(name as SubagentTargetFile)) {
      throw new Error(`Invalid output schema: duplicate file ${name}`);
    }
    if (typeof content !== 'string') {
      throw new Error(`Invalid output schema: content is required for ${name}`);
    }
    const leakedTerm = FORBIDDEN_CONTENT_TERMS.find((term) => content.includes(term));
    if (leakedTerm) {
      throw new Error(`Invalid draft content: ${name} leaked generator instruction "${leakedTerm}"`);
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
    seenFiles.add(normalized.name);
    draftByFile[normalized.name] = normalized;
  }
  const missingFile = SUBAGENT_TARGET_FILES.find((file) => !seenFiles.has(file));
  if (missingFile) {
    throw new Error(`Invalid output schema: missing file ${missingFile}`);
  }

  return {
    draftByFile,
  };
}

export function buildDraftRepairPrompt(errorMessage: string): string {
  return [
    '上一条输出不能作为草稿使用。',
    `失败原因：${errorMessage}`,
    '请重新输出完整 JSON 对象，不要 Markdown 代码块，不要任何额外解释。',
    `严格使用结构：${DRAFT_OUTPUT_SCHEMA}。`,
    '必须包含且仅包含 AGENTS.md、SOUL.md、TOOLS.md、IDENTITY.md、USER.md 五个文件。',
    'content 必须只写目标工作区最终文件内容，不能出现生成器身份、生成协议、文件职责说明、用户提示词标签或 JSON 规则。',
    'content 内不要使用 ``` 代码块；若有双引号必须转义为 \\\\"。',
    '请让 5 个文件全部围绕用户真正目标重写，并确保 JSON 完整闭合。',
  ].join('\n');
}

export function parseDraftByFile(output: string): DraftByFile {
  const parsed = parseDraftPayload(output);
  return parsed.draftByFile;
}
