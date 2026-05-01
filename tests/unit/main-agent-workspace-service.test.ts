import { describe, expect, it } from 'vitest';
import { shouldReplaceWorkspaceTemplateWithManagedVersion } from '../../electron/services/openclaw/main-agent-workspace-service';

describe('main-agent-workspace-service', () => {
  it('treats CRLF/LF-only differences as the same upstream template', () => {
    const current = '# AGENTS.md\r\n\r\nHello\r\n';
    const upstream = '# AGENTS.md\n\nHello\n';

    expect(shouldReplaceWorkspaceTemplateWithManagedVersion(current, upstream)).toBe(true);
  });

  it('does not replace a workspace file once it diverges from the upstream default', () => {
    const current = '# AGENTS.md\n\nCustomized for this user\n';
    const upstream = '# AGENTS.md\n\nOfficial default\n';

    expect(shouldReplaceWorkspaceTemplateWithManagedVersion(current, upstream)).toBe(false);
  });
});
