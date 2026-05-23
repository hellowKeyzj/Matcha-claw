import type { TaskItem } from '../domain/task-item.js'
import { isTaskStatus } from '../domain/task-status.js'
import { normalizeStringList } from '../shared/params.js'

export const taskListParameters = {
  type: 'object',
  description: String.raw`Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)

Use TaskGet with a specific task ID to view full details including description and comments.

## Task List Coordination (Teams)

When working in a team, all teammates share the same task list. Teammates should:
1. Check TaskList periodically, **especially after completing each task**, to find available work or see newly unblocked tasks
2. Claim unassigned, unblocked tasks with TaskUpdate (set \`owner\` to your name). **Prefer tasks in ID order** (lowest ID first)
3. Create new tasks with TaskCreate when identifying additional work
4. Mark tasks as completed with TaskUpdate when done, then check TaskList for next work
5. Coordinate with other teammates by reading the task list status
6. If all available tasks are blocked, notify the team lead or help resolve blocking tasks`,
  additionalProperties: false,
  properties: {},
} as const

export const taskGetParameters = {
  type: 'object',
  description: String.raw`Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.`,
  additionalProperties: false,
  required: ['taskId'],
  properties: {
    taskId: { type: 'string', description: 'Required. The ID of the task to retrieve.' },
  },
} as const

export const todoGetParameters = {
  type: 'object',
  description: 'Get the current session todo list. Use this before TodoWrite when you need the latest oldTodos for stale update detection. No parameters.',
  additionalProperties: false,
  properties: {},
} as const

export const taskOutputParameters = {
  type: 'object',
  description: String.raw`- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a taskId parameter identifying the task
- Returns the task output along with status information
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions`,
  additionalProperties: false,
  required: ['taskId'],
  properties: {
    taskId: { type: 'string', description: 'Required. The ID of the background task.' },
  },
} as const

export const taskStopParameters = {
  type: 'object',
  description: String.raw`
- Stops a running background task by its ID
- Takes a taskId parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task`,
  additionalProperties: false,
  required: ['taskId'],
  properties: {
    taskId: { type: 'string', description: 'Required. The ID of the background task to stop.' },
  },
} as const

export const todoItemParameters = {
  type: 'object',
  description: 'One todo item in the replacement todo list.',
  additionalProperties: false,
  required: ['content', 'status'],
  properties: {
    id: { type: 'string', description: 'Optional stable todo ID.' },
    content: { type: 'string', description: 'Required. Todo text shown to the user.' },
    activeForm: { type: 'string', description: 'Optional. Present-progress label shown while in_progress.' },
    status: {
      type: 'string',
      enum: ['pending', 'in_progress', 'completed'],
      description: 'Required. Todo status: pending, in_progress, or completed.',
    },
    owner: { type: 'string', description: 'Optional owner name or agent id.' },
  },
} as const

export const todoWriteParameters = {
  type: 'object',
  description: String.raw`Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool
Use this tool proactively in these scenarios:

1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
3. User explicitly requests todo list - When the user directly asks you to use the todo list
4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
5. After receiving new instructions - Immediately capture user requirements as todos
6. When you start working on a task - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time
7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Examples of When to Use the Todo List

<example>
User: I want to add a dark mode toggle to the application settings. Make sure you run the tests and build when you're done!
Assistant: I'll help add a dark mode toggle to your application settings. Let me create a todo list to track this implementation.
*Creates todo list with the following items:*
1. Creating dark mode toggle component in Settings page
2. Adding dark mode state management (context/store)
3. Implementing CSS-in-JS styles for dark theme
4. Updating existing components to support theme switching
5. Running tests and build process, addressing any failures or errors that occur
*Begins working on the first task*

<reasoning>
The assistant used the todo list because:
1. Adding dark mode is a multi-step feature requiring UI, state management, and styling changes
2. The user explicitly requested tests and build be run afterward
3. The assistant inferred that tests and build need to pass by adding "Ensure tests and build succeed" as the final task
</reasoning>
</example>

<example>
User: Help me rename the function getCwd to getCurrentWorkingDirectory across my project
Assistant: Let me first search through your codebase to find all occurrences of 'getCwd'.
*Uses grep or search tools to locate all instances of getCwd in the codebase*
Assistant: I've found 15 instances of 'getCwd' across 8 different files. Let me create a todo list to track these changes.
*Creates todo list with specific items for each file that needs updating*

<reasoning>
The assistant used the todo list because:
1. First, the assistant searched to understand the scope of the task
2. Upon finding multiple occurrences across different files, it determined this was a complex task with multiple steps
3. The todo list helps ensure every instance is tracked and updated systematically
4. This approach prevents missing any occurrences and maintains code consistency
</reasoning>
</example>

<example>
User: I need to implement these features for my e-commerce site: user registration, product catalog, shopping cart, and checkout flow.
Assistant: I'll help implement these features. First, let's add all the features to the todo list.
*Creates a todo list breaking down each feature into specific tasks based on the project architecture*
Assistant: Let's start with user registration. This will involve creating database models, API endpoints, and frontend forms that integrate with your existing authentication system.

<reasoning>
The assistant used the todo list because:
1. The user provided multiple complex features to implement in a comma separated list
2. The todo list helps organize these large features into manageable tasks
3. This approach allows for tracking progress across the entire implementation
</reasoning>
</example>

<example>
User: Can you help optimize my React application? It's rendering slowly and has performance issues.
Assistant: I'll help optimize your React application. First, let me examine your codebase to identify potential performance bottlenecks.
*Reviews component structure, render patterns, state management, and data fetching*
Assistant: After analyzing your codebase, I've identified several performance issues. Let me create a todo list to track our optimization efforts.
*Creates todo list with items like: 1) Implementing memoization for expensive calculations in ProductList, 2) Adding virtualization for long lists in Dashboard, 3) Optimizing image loading in Gallery component, 4) Fixing state update loops in ShoppingCart, 5) Reviewing bundle size and implementing code splitting*
Let's start by implementing memoization for the expensive calculations in your ProductList component.

<reasoning>
The assistant used the todo list because:
1. First, the assistant examined the codebase to identify specific performance issues
2. Based on this analysis, it identified multiple optimization opportunities
3. Performance optimization is a non-trivial task requiring multiple steps
4. The todo list helps methodically track improvements across different components
5. This systematic approach ensures all performance bottlenecks are addressed
</reasoning>
</example>

## Examples of When NOT to Use the Todo List

<example>
User: How do I print 'Hello World' in Python?
Assistant: In Python, you can print "Hello World" with this simple code:

python
print("Hello World")

This will output the text "Hello World" to the console when executed.

<reasoning>
The assistant did not use the todo list because this is a single, trivial task that can be completed in one step. There's no need to track multiple tasks or steps for such a straightforward request.
</reasoning>
</example>

<example>
User: What does the git status command do?
Assistant: The git status command shows the current state of your working directory and staging area. It displays which changes have been staged, which haven't, and which files aren't being tracked by Git. This is a fundamental command for understanding the current state of your repository before making commits.

<reasoning>
The assistant did not use the todo list because this is an informational request with no actual coding task to complete. The user is simply asking for an explanation, not for the assistant to perform multiple steps or tasks.
</reasoning>
</example>

<example>
User: Can you add a comment to the calculateTotal function to explain what it does?
Assistant: Sure, let me add a comment to the calculateTotal function to explain what it does.
* Uses the Edit tool to add a comment to the calculateTotal function *

<reasoning>
The assistant did not use the todo list because this is a single, straightforward task confined to one location in the code. Adding a comment doesn't require tracking multiple steps or systematic organization.
</reasoning>
</example>

<example>
User: Run npm install for me and tell me what happens.
Assistant: I'll run the npm install command for you.

*Executes: npm install*

The command completed successfully. Here's the output:
[Output of npm install command]

All dependencies have been installed according to your package.json file.

<reasoning>
The assistant did not use the todo list because this is a single command execution with immediate results. There are no multiple steps to track or organize, making the todo list unnecessary for this straightforward task.
</reasoning>
</example>

## Tool Usage Example

Here's an example of how to use this tool:

\`\`\`json
{
  "oldTodos": [],
  "newTodos": [
    {
      "content": "Add dark mode toggle to Settings page",
      "activeForm": "Adding a dark mode toggle button to the settings page",
      "status": "in_progress"
    },
    {
      "content": "Update existing components to support theme switching",
      "activeForm": "Updating existing components to support theme switching",
      "status": "pending"
    },
    {
      "content": "Run tests and ensure they pass",
      "activeForm": "Running tests and checking if they pass.",
      "status": "pending"
    }
  ]
}
\`\`\`

Here is an example of what was accomplished using this tool:

\`\`\`json
{
  "oldTodos": [
    {
      "content": "Add dark mode toggle to Settings page",
      "activeForm": "Adding a dark mode toggle button to the settings page",
      "status": "completed"
    },
    {
      "content": "Update existing components to support theme switching",
      "activeForm": "Updating existing components to support theme switching",
      "status": "completed"
    },
    {
      "content": "Run tests and ensure they pass",
      "activeForm": "Running tests and checking if they pass.",
      "status": "completed"
    }
  ],
  "newTodos": []
}
\`\`\`

## Task States and Management

1. **Task States**: Use these states to track progress:
   - pending: Task not yet started
   - in_progress: Currently working on (limit to ONE task at a time)
   - completed: Task finished successfully

   **IMPORTANT**: Task descriptions must have two forms:
   - content: The imperative form describing what needs to be done (e.g., "Run tests", "Build the project")
   - activeForm: The present continuous form shown during execution (e.g., "Running tests", "Building the project")

2. **Task Management**:
   - Update task status in real-time as you work
   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
   - Exactly ONE task must be in_progress at any time (not less, not more)
   - Complete current tasks before starting new ones
   - Remove tasks that are no longer relevant from the list entirely
   - Every time you update the todo list, return ALL tasks (both completed and pending)
   - When all tasks are completed, return an empty newTodos array as the final state

3. **Task Completion Requirements**:
   - ONLY mark a task as completed when you have FULLY accomplished it
   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress
   - When blocked, create a new task describing what needs to be resolved
   - Never mark a task as completed if:
     - Tests are failing
     - Implementation is partial
     - You encountered unresolved errors
     - You couldn't find necessary files or dependencies

4. **Task Breakdown**:
   - Create specific, actionable items
   - Break complex tasks into smaller, manageable steps
   - Use clear, descriptive task names
   - Always provide both forms:
     - content: "Fix authentication bug"
     - activeForm: "Fixing authentication bug"

## CRITICAL: Task Completion Protocol

**You MUST follow this protocol to properly complete a task session:**

1. **Initial Task Definition**: When creating the todo list, ensure you have identified ALL tasks required to fulfill the user's request. Be thorough and comprehensive—missing tasks is a failure.

2. **Progressive Tracking**: After completing each task, IMMEDIATELY call TodoWrite to:
   - Move the completed task from pending/in_progress to completed status
   - Update the next task to in_progress in newTodos
   - If no more tasks remain, set newTodos to an empty array

3. **Mid-Session Checkpoints**: For longer task sessions:
   - After every 3-5 completed tasks, explicitly summarize what has been accomplished
   - State how many tasks remain
   - Confirm you are continuing with the remaining tasks

4. **Final Completion**: When all tasks are done:
   - Call TodoWrite one final time with an empty newTodos array
   - Move ALL completed tasks to oldTodos with "completed" status
   - Explicitly confirm to the user: "All tasks have been completed successfully"
   - List what was accomplished

5. **Validation Before Stopping**:
   Before ending your work, verify:
   - ✓ Every task in the original list has been addressed
   - ✓ Every task is marked as "completed" in oldTodos or "completed" in the final TodoWrite call
   - ✓ No task remains in a "pending" or "in_progress" state
   - ✓ You have returned an empty newTodos array to formally conclude the task session
   - ✓ You have informed the user that all work is complete

**FAILURE CONDITION**: If you stop working without returning an empty newTodos array, it signals that:
- The task session is incomplete
- There are unfinished tasks
- The user may need to request continuation

This is non-negotiable. Every task session must end with an empty newTodos array and explicit user confirmation.

Always pass oldTodos exactly as last returned by TodoGet, TodoWrite, TaskList, or a task tool result; stale oldTodos will be rejected.

When in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.`,
  additionalProperties: false,
  required: ['oldTodos', 'newTodos'],
  properties: {
    oldTodos: {
      type: 'array',
      description: 'Required. Current todo list before the update, exactly as last returned by TodoGet, TodoWrite, TaskList, or a task tool result. Used for stale update detection.',
      items: todoItemParameters,
    },
    newTodos: {
      type: 'array',
      description: 'Required. Complete replacement list after the update. Example: {"oldTodos":[{"content":"Analyze page structure","status":"in_progress"}],"newTodos":[{"content":"Analyze page structure","status":"completed"}]}. Use newTodos: [] only when clearing all todos.',
      items: todoItemParameters,
    },
  },
} as const

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function asTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

export function normalizeTaskRecord(raw: unknown): TaskItem | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const row = raw as Record<string, unknown>
  const id = asTrimmedString(row.id)
  const subject = asTrimmedString(row.subject)
  const description = asTrimmedString(row.description)
  const createdAt = asTimestamp(row.createdAt)
  const updatedAt = asTimestamp(row.updatedAt)

  if (!id || !subject || !description || !createdAt || !updatedAt || !isTaskStatus(row.status)) {
    return null
  }

  const normalized: TaskItem = {
    id,
    subject,
    description,
    status: row.status,
    blockedBy: normalizeStringList(row.blockedBy),
    blocks: normalizeStringList(row.blocks),
    createdAt,
    updatedAt,
  }

  const activeForm = asTrimmedString(row.activeForm)
  const owner = asTrimmedString(row.owner)
  const metadata = asMetadata(row.metadata)

  if (activeForm) {
    normalized.activeForm = activeForm
  }
  if (owner) {
    normalized.owner = owner
  }
  if (metadata) {
    normalized.metadata = metadata
  }

  return normalized
}
