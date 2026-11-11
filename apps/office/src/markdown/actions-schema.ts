import Ajv from 'ajv';
import type { AppJson } from '@matcha/app-plugins-sdk';
import { buildOpsGuide } from '../../genoffice/apps/markdown/src/renderer/editor/ops';
import { MIND_MAP_TOOL } from '../../genoffice/packages/agent-core/src/mind-map';

// Tool descriptions and schemas are mechanically retained from upstream AGENT_TOOLS.
const tools = [{
    name: 'get_document_context',
    description:
      'Refresh the document overview: a numbered list of top-level blocks (index | type | preview) plus the current selection. Call this before index-based edits when in doubt.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
{
    name: 'read_blocks',
    description:
      'Read a range of top-level blocks as markdown. Long output is paged; a notice tells you the offset to continue from.',
    inputSchema: {
      type: 'object',
      properties: {
        startIndex: { type: 'integer', description: '0-based index of the first block' },
        endIndex: { type: 'integer', description: '0-based index of the last block (inclusive)' },
        offset: {
          type: 'integer',
          description: 'Character offset to continue a previously truncated read',
        },
      },
      required: ['startIndex', 'endIndex'],
    },
  },
{
    name: 'apply_ops',
    description: `Edit the document with a batch of ops — the same operations the editor's own toolbar performs. Ops run in order and stop at the first failure; the result lists what each op did.\n\n${buildOpsGuide()}`,
    inputSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          description: 'Ordered list of op objects (see the op catalogue)',
          items: { type: 'object' },
        },
      },
      required: ['ops'],
    },
  },
{
    name: 'read_frontmatter',
    description:
      'Read the document properties: the raw YAML frontmatter block at the top of the file (title, tags, date, …), without the --- fences. Write it back with the setFrontmatter op.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  }, MIND_MAP_TOOL];
const schemas: Record<string, Record<string, unknown>> = Object.fromEntries(tools.map(tool => [tool.name, { ...tool.inputSchema, additionalProperties: false }]));
Object.assign(schemas, {
  anchor_selection: { type: 'object', properties: {}, additionalProperties: false },
  resolve_anchor: { type: 'object', properties: { qid: { type: 'string', minLength: 1 } }, required: ['qid'], additionalProperties: false },
  focus_anchor: { type: 'object', properties: { qid: { type: 'string', minLength: 1 } }, required: ['qid'], additionalProperties: false },
  remove_anchor: { type: 'object', properties: { qid: { type: 'string', minLength: 1 } }, required: ['qid'], additionalProperties: false },
  navigate: { type: 'object', properties: { index: { type: 'integer', minimum: 0 } }, required: ['index'], additionalProperties: false },
});
export const markdownActionSchemas = schemas;
export const markdownActionInputSchema = {
  type: 'object', properties: { documentId: { type: 'string', pattern: '^doc_[a-f0-9]{16}$' }, action: { type: 'string', enum: Object.keys(schemas) }, input: { type: 'object' } },
  required: ['documentId', 'action', 'input'], additionalProperties: false,
  oneOf: Object.entries(schemas).map(([action, input]) => ({ properties: { action: { const: action }, input } })),
};
const validate = new Ajv({ strict: true }).compile(markdownActionInputSchema);
export function validateMarkdownAction(value: unknown): asserts value is { documentId: string; action: string; input: Record<string, AppJson> } {
  if (!validate(value)) throw new Error('Invalid Markdown action: ' + JSON.stringify(validate.errors));
}
