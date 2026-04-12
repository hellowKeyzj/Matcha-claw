export const taskCreateParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'description'],
  properties: {
    taskListId: { type: 'string' },
    subject: { type: 'string' },
    description: { type: 'string' },
    activeForm: { type: 'string' },
    metadata: { type: 'object', additionalProperties: true },
  },
} as const
