export const taskCreateParameters = {
  type: 'object',
  description: 'Create one persisted task for the current session. Required fields: subject and description.',
  additionalProperties: false,
  required: ['subject', 'description'],
  properties: {
    subject: {
      type: 'string',
      description: 'Required. Short task title, for example "Analyze page structure".',
    },
    description: {
      type: 'string',
      description: 'Required. Concrete work to perform or verify.',
    },
    activeForm: {
      type: 'string',
      description: 'Optional. Present-progress label shown while in_progress, for example "Analyzing page structure".',
    },
    metadata: {
      type: 'object',
      description: 'Optional JSON object with extra task metadata. Do not pass an array.',
      additionalProperties: true,
    },
    owner: {
      type: 'string',
      description: 'Optional owner name or agent id.',
    },
  },
} as const
