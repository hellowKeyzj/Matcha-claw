import type { DocumentResource } from '../documents/model';
import { documentSnapshot } from './resources';

let source = '';
let name = 'index.html';
let resources: readonly DocumentResource[] = [];
let resourceVersion = 0;
const listeners = new Set<() => void>();
export const preview = {
  snapshot() { return documentSnapshot(source, resources, name); },
  resourceVersion: () => resourceVersion,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  name(value: string) { name = value; },
  update(html: string) { source = html; },
  resources(value: readonly DocumentResource[]) { resources = value; },
  acceptResources(value: readonly DocumentResource[]) {
    const previous = new Map(resources.map(resource => [resource.path, resource.bytes]));
    const changed = value.length !== resources.length || value.some(({ path, bytes }) => {
      const before = previous.get(path);
      return !before || before.length !== bytes.length || bytes.some((byte, index) => byte !== before[index]);
    });
    resources = value;
    if (changed) { resourceVersion++; for (const listener of listeners) listener(); }
  }
};
