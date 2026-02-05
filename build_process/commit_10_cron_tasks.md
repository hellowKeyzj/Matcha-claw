# Commit 10: Cron Tasks Management

## Summary
Enhance the Cron tasks page with a create/edit dialog, schedule presets, human-readable cron parsing, and improved job cards with better UX.

## Changes

### React Renderer

#### `src/pages/Cron/index.tsx`
Complete rewrite with enhanced features:

**New Components:**
- `TaskDialog` - Create/edit scheduled task modal
- `CronJobCard` - Enhanced job display with actions

**Features:**
- Schedule presets (every minute, hourly, daily, weekly, monthly)
- Custom cron expression input
- Channel selection for task targets
- Human-readable cron schedule parsing
- Run now functionality with loading state
- Delete confirmation
- Gateway connection status awareness
- Failed tasks counter in statistics
- Error display for last run failures

**UI Improvements:**
- Message preview in job cards
- Status-aware card borders
- Last run success/failure indicators
- Next run countdown
- Action buttons with labels
- Responsive statistics grid

### Data Structures

#### Schedule Presets
```typescript
const schedulePresets = [
  { label: 'Every minute', value: '* * * * *', type: 'interval' },
  { label: 'Every 5 minutes', value: '*/5 * * * *', type: 'interval' },
  { label: 'Every 15 minutes', value: '*/15 * * * *', type: 'interval' },
  { label: 'Every hour', value: '0 * * * *', type: 'interval' },
  { label: 'Daily at 9am', value: '0 9 * * *', type: 'daily' },
  { label: 'Daily at 6pm', value: '0 18 * * *', type: 'daily' },
  { label: 'Weekly (Mon 9am)', value: '0 9 * * 1', type: 'weekly' },
  { label: 'Monthly (1st at 9am)', value: '0 9 1 * *', type: 'monthly' },
];
```

## Technical Details

### Component Architecture

```
Cron Page
    |
    +-- Header (title, refresh, new task button)
    |
    +-- Gateway Warning (if not running)
    |
    +-- Statistics Grid
    |     |
    |     +-- Total Tasks
    |     +-- Active Tasks
    |     +-- Paused Tasks
    |     +-- Failed Tasks
    |
    +-- Error Display (if any)
    |
    +-- Jobs List
    |     |
    |     +-- CronJobCard (for each job)
    |           |
    |           +-- Header (name, schedule, status toggle)
    |           +-- Message Preview
    |           +-- Metadata (channel, last run, next run)
    |           +-- Error Display (if last run failed)
    |           +-- Actions (run, edit, delete)
    |
    +-- TaskDialog (modal)
          |
          +-- Name Input
          +-- Message/Prompt Textarea
          +-- Schedule Presets / Custom Cron
          +-- Channel Selection
          +-- Enable Toggle
          +-- Save/Cancel Actions
```

### Cron Parsing Logic

```typescript
function parseCronSchedule(cron: string): string {
  // Check against presets first
  const preset = schedulePresets.find((p) => p.value === cron);
  if (preset) return preset.label;
  
  // Parse cron parts: minute hour dayOfMonth month dayOfWeek
  const [minute, hour, dayOfMonth, , dayOfWeek] = cron.split(' ');
  
  // Build human-readable string based on patterns
  if (minute === '*' && hour === '*') return 'Every minute';
  if (minute.startsWith('*/')) return `Every ${minute.slice(2)} minutes`;
  if (dayOfWeek !== '*') return `Weekly on ${day} at ${time}`;
  if (dayOfMonth !== '*') return `Monthly on day ${dayOfMonth} at ${time}`;
  if (hour !== '*') return `Daily at ${time}`;
  
  return cron; // Fallback to raw expression
}
```

### State Management

**Local State:**
- `showDialog` - Dialog visibility
- `editingJob` - Job being edited (undefined for create)
- `triggering` - Run now loading state per card

**Store Integration:**
- `useCronStore` - Jobs data and CRUD actions
- `useChannelsStore` - Available channels for targets
- `useGatewayStore` - Connection status

### Form Validation

**Required Fields:**
- Task name (non-empty string)
- Message/prompt (non-empty string)
- Schedule (preset or valid cron expression)
- Target channel (selected from available channels)

### Statistics Calculation

```typescript
const activeJobs = jobs.filter((j) => j.enabled);
const pausedJobs = jobs.filter((j) => !j.enabled);
const failedJobs = jobs.filter((j) => j.lastRun && !j.lastRun.success);
```

## UI States

**Job Card:**
- Active: Green border, green clock icon
- Paused: Neutral border, muted clock icon
- Failed: Shows error message with red background

**Task Dialog:**
- Create mode: Empty form, "Create Task" button
- Edit mode: Pre-filled form, "Save Changes" button
- Saving: Disabled inputs, loading spinner

## Version
v0.1.0-alpha (final feature)
