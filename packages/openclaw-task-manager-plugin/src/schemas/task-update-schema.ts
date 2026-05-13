export const taskUpdateParameters = {
  type: 'object',
  description: 'Update an existing task. taskId is required, and at least one update field must be provided. Use status=deleted to remove a task.',
  additionalProperties: false,
  required: ['taskId'],
  properties: {
    taskId: { type: 'string', description: 'Required. The ID of the task to update.' },
    status: {
      type: 'string',
      enum: ['pending', 'in_progress', 'completed', 'deleted'],
      description: 'Optional. New status: pending, in_progress, completed, or deleted. deleted removes the task.',
    },
    subject: { type: 'string', description: 'Optional. Replacement short task title.' },
    description: { type: 'string', description: 'Optional. Replacement task description.' },
    activeForm: { type: 'string', description: 'Optional. Present-progress label shown while in_progress.' },
    owner: { type: 'string', description: 'Optional. Replacement owner name or agent id.' },
    addBlockedBy: {
      type: 'array',
      description: 'Optional. Task IDs that block this task. Every item must be a non-empty string.',
      items: { type: 'string' },
    },
    addBlocks: {
      type: 'array',
      description: 'Optional. Task IDs that this task blocks. Every item must be a non-empty string.',
      items: { type: 'string' },
    },
    metadata: {
      type: 'object',
      description: 'Optional JSON object with metadata keys to merge. Set a key to null to delete it. Do not pass an array.',
      additionalProperties: true,
    },
  },
} as const
