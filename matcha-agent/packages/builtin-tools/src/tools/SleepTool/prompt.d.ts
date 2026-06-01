export declare const SLEEP_TOOL_NAME = 'Sleep'
export declare const DESCRIPTION = 'Wait for a specified duration'
export declare const SLEEP_TOOL_PROMPT =
  "Wait for a specified duration. The user can interrupt the sleep at any time.\n\nUse this when the user tells you to sleep or rest, when you have nothing to do, or when you're waiting for something.\n\nYou may receive <tick> prompts \u2014 these are periodic check-ins. Look for useful work to do before sleeping.\n\nYou can call this concurrently with other tools \u2014 it won't interfere with them.\n\nPrefer this over `Bash(sleep ...)` \u2014 it doesn't hold a shell process.\n\nEach wake-up costs an API call, but the prompt cache expires after 5 minutes of inactivity \u2014 balance accordingly."
