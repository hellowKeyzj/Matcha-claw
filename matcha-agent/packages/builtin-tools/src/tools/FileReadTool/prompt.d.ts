export declare const FILE_READ_TOOL_NAME = 'Read'
export declare const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current \u2014 refer to that instead of re-reading.'
export declare const MAX_LINES_TO_READ = 2000
export declare const DESCRIPTION = 'Read a file from the local filesystem.'
export declare const LINE_FORMAT_INSTRUCTION =
  '- Results are returned using cat -n format, with line numbers starting at 1'
export declare const OFFSET_INSTRUCTION_DEFAULT =
  "- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters"
export declare const OFFSET_INSTRUCTION_TARGETED =
  '- When you already know which part of the file you need, only read that part. This can be important for larger files.'
/**
 * Renders the Read tool prompt template.  The caller (FileReadTool) supplies
 * the runtime-computed parts.
 */
export declare function renderPromptTemplate(
  lineFormat: string,
  maxSizeInstruction: string,
  offsetInstruction: string,
): string
