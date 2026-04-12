export const taskUpdateParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId'],
  properties: {
    taskListId: { type: 'string' },
    taskId: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
    subject: { type: 'string' },
    description: { type: 'string' },
    activeForm: { type: ['string', 'null'] },
    owner: { type: ['string', 'null'] },
    addBlockedBy: { type: 'array', items: { type: 'string' } },
    addBlocks: { type: 'array', items: { type: 'string' } },
    metadata: { type: 'object', additionalProperties: true },
  },
} as const
