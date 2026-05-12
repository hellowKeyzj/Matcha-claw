export const taskUpdateParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId'],
  properties: {
    taskId: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] },
    subject: { type: 'string' },
    description: { type: 'string' },
    activeForm: { type: 'string' },
    owner: { type: 'string' },
    addBlockedBy: { type: 'array', items: { type: 'string' } },
    addBlocks: { type: 'array', items: { type: 'string' } },
    metadata: { type: 'object', additionalProperties: true },
  },
} as const
