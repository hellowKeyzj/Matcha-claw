import { Interaction, notes } from '@serenity-js/core';
import { UseElectron } from '../abilities/use-electron.ability.js';

export const RequestMalformedSessionCatalog = () => Interaction.where('#actor submits an extra private field to the public session catalog', async actor => {
  const endpoint = { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' };
  const reply = await actor.abilityTo(UseElectron).fetchHostApi({
    path: '/api/capabilities/execute',
    method: 'POST',
    body: {
      id: 'session.management',
      operationId: 'sessions.list',
      scope: { kind: 'runtime-instance', endpoint },
      target: { kind: 'runtime-endpoint' },
      input: { endpoint },
      privateToken: 'must-not-leak',
    },
  });
  const rejection = {
    ipcOk: reply.ok,
    status: reply.ok ? reply.data.status : null,
    httpOk: reply.ok ? reply.data.ok : false,
    body: reply.ok ? reply.data.json : null,
    reflectsInput: JSON.stringify(reply).includes('must-not-leak'),
  };
  await notes<{ malformedSessionCatalogRejection: typeof rejection }>()
    .set('malformedSessionCatalogRejection', rejection).performAs(actor);
});
