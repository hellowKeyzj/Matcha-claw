import { createHtmlSkillCore, type HtmlDocAccess } from '../../genoffice/apps/html/src/renderer/ai/tools';
import { briefPinEdit, injectBrief, type Brief } from '../../genoffice/apps/html/src/renderer/document/brief';
import { buildProjection } from '../../genoffice/apps/html/src/renderer/ai/redact';
import { redactGuardForOps } from '../../genoffice/apps/html/src/renderer/ai/redact-guard';
const ACTIONS = new Set(['context', 'get_outline', 'read_source', 'apply_ops', 'pin_brief']);

export function createHtmlActions(access: HtmlDocAccess) {
  const core = createHtmlSkillCore(access);
  let seenVersion = -1;
  return async (action: string, input: Record<string, unknown> = {}) => {
    // The backend validates the original schema before dispatch. Do not ship Ajv codegen into the opaque frame.
    if (!ACTIONS.has(action)) throw new Error('Unsupported HTML document action.');
    if (action === 'context') {
      const output = core.buildContext();
      seenVersion = access.getVersion();
      return { output, version: seenVersion };
    }
    if (action === 'pin_brief') {
      if (access.getLastManualVersion() > seenVersion) return { isError: true, output: 'The document changed. Read context, get_outline or read_source before editing.' };
      const brief = input.brief as Brief;
      const text = access.getText();
      const edit = briefPinEdit(text, brief);
      const next = injectBrief(text, brief);
      if (next === text) return { output: 'The pinned brief is already current.', mutated: false };
      // Use the same guard as model source edits; a brief must not overwrite withheld text.
      const ops = edit ? [{ op: 'str_replace' as const, old: edit.old, new: edit.new }] : null;
      const projection = buildProjection(text, access.getMap());
      const refusal = ops && redactGuardForOps(ops, projection, access.getMap());
      if (refusal || (!ops && !projection.empty)) return { isError: true, output: refusal?.reason ?? 'The document contains withheld text.' };
      if (ops) {
        const result = access.applyOps(ops, 'pin brief');
        if (!result.ok) return { isError: true, output: result.errors.map(error => error.message).join('\n') };
      } else access.replaceAll(next, 'pin brief');
      seenVersion = access.getVersion();
      // Synchronize the original core's freshness after our own successful edit.
      core.buildContext();
      return { output: 'Brief pinned.', mutated: true, version: seenVersion };
    }
    const result = await core.executeTool({ id: crypto.randomUUID(), name: action, input });
    if (!result.isError) seenVersion = access.getVersion();
    return { ...result, version: access.getVersion() };
  };
}
