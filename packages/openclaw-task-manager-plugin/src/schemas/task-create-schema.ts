export const taskCreateParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'description'],
  properties: {
    subject: { type: 'string' },
    description: { type: 'string' },
    activeForm: { type: 'string' },
    metadata: { type: 'object', additionalProperties: true },
    owner: { type: 'string' },
  },
} as const
