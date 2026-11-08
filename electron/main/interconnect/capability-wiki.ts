import { isAppServiceRequest } from '../../../sdk/app-plugins/src/services';
import { decodeAppKnowledgeRead, decodeAppKnowledgeSearch } from '../app-plugins/knowledge';
import { hasExactKeys, isNonEmptyBoundedText, isRecord } from '../runtime-host-delivery/transport/client';
import type { RuntimeHostTransports } from '../runtime-host-delivery/transport/host-api-transports';
import type { SharedCapabilityCandidate, SharedCapabilityProvider } from './capability';

const READ_INPUT = {
  type: 'object', additionalProperties: false, required: ['relativePath'],
  properties: { relativePath: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^(?!\\.{1,2}(?:/|$))[^/\\\\:\\u0000]+(?:/(?!\\.{1,2}(?:/|$))[^/\\\\:\\u0000]+)*$' } },
};
const SEARCH_INPUT = {
  type: 'object', additionalProperties: false, required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 16_384, pattern: '^[^\\u0000]*\\S[^\\u0000]*$' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
};

export function createWikiCapabilityProvider(getTransports: () => Promise<RuntimeHostTransports>): SharedCapabilityProvider {
  return {
    id: 'wiki',
    async list() {
      const response = await (await getTransports()).wikiTransport.projects();
      if (response.status !== 200 || !isRecord(response.body) || !Array.isArray(response.body.projects)) return [];
      const projects = response.body.projects;
      if (!projects.every((project) => isRecord(project) && isNonEmptyBoundedText(project.projectId) && typeof project.title === 'string')
        || new Set(projects.map((project) => project.projectId)).size !== projects.length) return [];
      return projects.flatMap((project) => {
        const projectId = project.projectId as string;
        const title = project.title as string;
        return (['read', 'search'] as const).map((operation): SharedCapabilityCandidate => ({
          definition: { kind: 'builtin', operation: `wiki.${operation}`, projectId, output: `AppKnowledgeResults.${operation}@1` },
          descriptor: {
            name: `${operation === 'read' ? 'Read document' : 'Search documents'} — ${title}`,
            description: `${operation === 'read' ? 'Read a relative document path in' : 'Search documents in'} the shared Wiki project ${title} (${projectId}). The project cannot be changed by the caller.`,
            inputSchema: structuredClone(operation === 'read' ? READ_INPUT : SEARCH_INPUT),
          },
          presentation: { kind: 'wiki', targetId: projectId, targetName: title, operation: `wiki.${operation}` },
          async execute(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
            if (signal.aborted) throw new Error('Document operation observation was cancelled.');
            try {
              const wiki = (await getTransports()).wikiTransport;
              if (signal.aborted) throw new Error('Document operation observation was cancelled.');
              if (operation === 'read') {
                const request = { service: 'knowledge', operation: 'read', input: { ...args, projectId } } as const;
                if (!hasExactKeys(args, ['relativePath']) || !isAppServiceRequest(request)) throw new Error('Invalid document read input.');
                const result = await wiki.readFile({ ...request.input, limit: 0 });
                if (signal.aborted || result.status !== 200) throw new Error('Document read could not be completed.');
                return decodeAppKnowledgeRead(result.body, request.input);
              }
              const request = { service: 'knowledge', operation: 'search', input: { ...args, projectId } } as const;
              if (!Object.keys(args).every((key) => key === 'query' || key === 'limit') || !isAppServiceRequest(request)) throw new Error('Invalid document search input.');
              const result = await wiki.search(request.input);
              if (signal.aborted || result.status !== 200) throw new Error('Document search could not be completed.');
              return decodeAppKnowledgeSearch(result.body, request.input);
            } catch {
              throw new Error('The document operation could not be completed.');
            }
          },
        }));
      });
    },
  };
}
