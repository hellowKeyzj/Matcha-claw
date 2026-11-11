// Mechanically extracted from the pinned upstream WORKBOOK_TOOLS; algorithms stay in the original live App.
import { guideCatalogSummary } from '../../genoffice/apps/sheets/src/renderer/ai/guides';
const MAX_FIND_RESULTS = 200;
const DEFAULT_FIND_RESULTS = 50;
export const sheetsActions = [
  {
    name: 'get_workbook_context',
    description:
      'Get a workbook overview: all sheets (id/name/data-extent rows-columns), active sheet, current selection, known non-empty cell addresses. ' +
      'For data-size questions (how many rows / how much data), answer from the data extent here instead of reading block by block; use read_range or read_cells when concrete values are needed.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_range',
    description:
      'Read current values/formulas by rectangular range, returning a grid with row numbers and column letters. ' +
      'The requested range is not the worksheet data extent: never infer total row or record count from its ending row; use get_workbook_context. ' +
      'This is the preferred way to read data; max 2000 cells — read larger regions in multiple calls.',
    inputSchema: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          description: 'Range like "A1:D20"; a single cell like "B2" is also accepted',
        },
        sheetId: {
          type: 'string',
          description:
            'Sheet to read from (id from get_workbook_context); reads the active sheet when omitted',
        },
      },
      required: ['range'],
    },
  },
  {
    name: 'aggregate_range',
    description:
      'Compute statistics for a range without reading or modifying it cell by cell: non-empty count, distinct-value count, ' +
      'numeric sum/average/min/max, and the most frequent values. Handles very large ranges (up to 1,000,000 cells) efficiently. ' +
      'ALWAYS use this for questions like "how many distinct suppliers/customers", value distributions, or column totals on large sheets — ' +
      'never loop read_range over big data and never write COUNTIF/SUMPRODUCT distinct-count formulas (they are rejected as too expensive). ' +
      'Aggregate one column at a time for meaningful distinct counts.',
    inputSchema: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          description: 'Range like "D2:D88588" (typically one column, excluding the header)',
        },
        sheetId: {
          type: 'string',
          description: 'Target sheet id; the active sheet when omitted',
        },
        topValues: {
          type: 'number',
          description: 'How many most-frequent values to return (0-50, default 10)',
        },
      },
      required: ['range'],
    },
  },
  {
    name: 'load_guide',
    description:
      'Load operation guide documents into context (field definitions, conventions, common mistakes). Except for the most basic single-cell reads/writes, load the relevant guides before generating propose_operations; several can be loaded at once. ' +
      `Available guides: ${guideCatalogSummary()}`,
    inputSchema: {
      type: 'object',
      properties: {
        guides: {
          type: 'array',
          items: { type: 'string' },
          description: 'Guide names to load, e.g. ["writing","formatting"]',
        },
      },
      required: ['guides'],
    },
  },
  {
    name: 'read_formats',
    description:
      'Read explicit cell formats in a range (bold/italic/underline/colors/number format/alignment/borders); only formatted cells are returned. ' +
      'Use when you need to "reuse the format from somewhere" or inspect current formatting; max 200 cells.',
    inputSchema: {
      type: 'object',
      properties: {
        range: { type: 'string', description: 'Range like "A1:D20"' },
        sheetId: {
          type: 'string',
          description:
            'Sheet to read from (id from get_workbook_context); reads the active sheet when omitted',
        },
      },
      required: ['range'],
    },
  },
  {
    name: 'read_sheet_features',
    description:
      "Read a worksheet's feature state: AutoFilter (range and column criteria), conditional formatting rules, data validation rules, defined names, " +
      'freeze panes, hidden/protected status, shapes and images, and page setup pending save this session. ' +
      'Read the current state before modifying or clearing any of these existing settings — never change them blindly.',
    inputSchema: {
      type: 'object',
      properties: {
        sheetId: {
          type: 'string',
          description: 'Target sheet id; reads the active sheet when omitted',
        },
      },
      required: [],
    },
  },
  {
    name: 'read_cells',
    description:
      'Read current values/formulas of specific scattered cells (use read_range for contiguous regions). Always read the affected cells before writing — never assume their contents.',
    inputSchema: {
      type: 'object',
      properties: {
        addresses: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of cell addresses, e.g. ["A1","B2"], max 100',
        },
        sheetId: {
          type: 'string',
          description:
            'Sheet to read from (id from get_workbook_context); reads the active sheet when omitted',
        },
      },
      required: ['addresses'],
    },
  },
  {
    name: 'find_cells',
    description:
      'Search the whole workbook (or one sheet) for cells whose value or formula matches a query; returns Sheet!Address with the cell content. ' +
      'Plain text matches as a case-insensitive substring; regex=true treats the query as a case-insensitive JavaScript regex; ' +
      'errors_only=true finds formula error cells (#REF!, #DIV/0!, #VALUE!, #NAME?, #N/A, #NUM!, #NULL!) and query may then be omitted. ' +
      'For formula cells the matched value is the last calculated value. Prefer this over paging read_range when locating data or auditing errors.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text or regex to find; may be omitted only when errors_only=true',
        },
        regex: {
          type: 'boolean',
          description: 'Treat query as a JavaScript regex (default false)',
        },
        look_in: {
          type: 'string',
          enum: ['values', 'formulas', 'both'],
          default: 'both',
          description: 'What to match against (default both)',
        },
        sheetId: {
          type: 'string',
          description: 'Restrict the search to one sheet; searches every sheet when omitted',
        },
        errors_only: {
          type: 'boolean',
          description: 'Find cells whose calculated value is a formula error (default false)',
        },
        max_results: {
          type: 'integer',
          description: `Maximum matches returned, default ${DEFAULT_FIND_RESULTS}, max ${MAX_FIND_RESULTS}`,
        },
      },
      required: [],
    },
  },
  {
    name: 'select_range',
    description:
      "Select a range in the grid and scroll the user's view to it, activating its sheet. " +
      'Pure view navigation — changes no data, but it does replace whatever the user had selected. ' +
      'Use it only when they asked to be moved ("take me there", "select those rows"); to merely point at a ' +
      'location, cite it as [C42](sheetnav://C42) in your reply and let them click.',
    inputSchema: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          description: 'Range like "A1:D20"; a single cell is also accepted',
        },
        sheetId: { type: 'string', description: 'Target sheet id; defaults to the active sheet' },
      },
      required: ['range'],
    },
  },
  {
    name: 'trace_precedents',
    description:
      'List the cells/ranges a formula reads (its precedents) with their current values, flagging any precedent that itself holds an error value — ' +
      'the first step when diagnosing a broken formula ("why is C10 #DIV/0!?"). Depth 1; call again on a suspect precedent to walk further up the chain. ' +
      'Defined names are not expanded — resolve them via read_sheet_features and trace their ranges directly.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Formula cell to audit, e.g. "C10"' },
        sheetId: {
          type: 'string',
          description: 'Sheet the cell lives on; defaults to the active sheet',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'trace_dependents',
    description:
      'Find every formula in the workbook (all sheets) that reads a given cell — its dependents. ' +
      'Use before changing or deleting a cell to see what would break, or to follow how an error value propagates downstream. ' +
      'Dependents that reach the cell only through a defined name are not detected.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Target cell, e.g. "B2"' },
        sheetId: {
          type: 'string',
          description: 'Sheet the cell lives on; defaults to the active sheet',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'propose_operations',
    description:
      'Submit a batch of change operations, applied to the workbook immediately (the user can roll back with the [Undo] button or ⌘Z). Basic operations: ' +
      '{op:"set_cell",sheetId,address,value} | {op:"set_formula",sheetId,address,formula(starts with =)} | ' +
      '{op:"clear_cell",sheetId,address} | {op:"rename_sheet",sheetId,name}. ' +
      'Field definitions for the remaining operations live in the guides — load_guide before using them: ' +
      'writing(set_range/fill_range/copy_range/move_range/convert_to_values/clear_range/find_replace) | formatting(format_range) | ' +
      'layout(sort_range/merge_cells/unmerge_cells/set_row_height/set_col_width/set_rows_hidden/set_cols_hidden/set_freeze/set_page_setup) | ' +
      'structure(insert_rows/delete_rows/insert_cols/delete_cols/add_sheet/delete_sheet/' +
      'duplicate_sheet/set_sheet_hidden/move_sheet/protect_sheet) | ' +
      'charts(add_chart/edit_chart/delete_visual/add_sparkline/add_shape/edit_shape/add_image) | ' +
      'pivot(add_pivot/refresh_pivot) | ' +
      'table(add_table/add_table_row/add_table_column/delete_table_row/delete_table_column/delete_table) | ' +
      'data(set_hyperlink/set_filter/clear_filter/set_filter_criteria/add_conditional_format/' +
      'clear_conditional_formats/set_data_validation/set_note/add_defined_name/delete_defined_name). ' +
      'Limits: structural operations (row/column insert-delete, sheet add/delete/duplicate/move/hide) cannot share a batch with other classes; at most 2000 expanded cell changes — ' +
      'except the range-level bulk ops fill_range / copy_range / move_range / convert_to_values / clear_range / find_replace / sort_range / format_range, which handle up to 200,000 cells in one op ' +
      '(use fill_range to fill a formula or pattern down a whole column instead of huge set_range batches, ' +
      'copy_range to duplicate a large block once, move_range to move/cut a block — also to another sheet — instead of re-typing it cell by cell, convert_to_values to freeze formulas into their computed values); ' +
      'sheetId must be an id returned by get_workbook_context.',
    inputSchema: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: { type: 'object' },
          description: 'Array of operations in the workbook DSL discriminated-union format',
        },
        summary: { type: 'string', description: 'One-sentence summary of this batch of changes' },
      },
      required: ['operations', 'summary'],
    },
  },
  {
    name: 'create_document',
    description:
      'Create a NEW standalone file in the default save folder and open it in a new tab; the current workbook is not modified. ' +
      "Types 'xlsx' (default) and 'csv' export ONE worksheet of THIS workbook: pass sheetId (defaults to the active sheet); the file gets the sheet's current displayed values (formula results; formulas and formatting are not carried over) and content must be omitted. " +
      'To split a workbook into separate files, call once per sheet. To export data that is not in a sheet yet, write it into a new sheet first (add_sheet + set_range), then export that sheet. ' +
      "Types 'docx' and 'pdf' take simple HTML in content (<h1>-<h6>, <p>, <ul>/<ol>/<li>, <table>, <pre>, <blockquote>; inline <strong>/<em>/<u>/<s>); type 'md' takes Markdown source; type 'html' takes a complete standalone HTML page (opens in the HTML editor) — use these when the user wants a report/summary as its own document. " +
      'title becomes the file name; xlsx/csv default it to the worksheet name.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['xlsx', 'csv', 'docx', 'pdf', 'md', 'html'],
          description: "target file type (default 'xlsx')",
        },
        sheetId: {
          type: 'string',
          description:
            'xlsx/csv only: the worksheet to export (id from get_workbook_context); defaults to the active sheet',
        },
        title: {
          type: 'string',
          description:
            'file name without extension (required for docx/pdf/md; xlsx/csv default to the sheet name)',
        },
        content: {
          type: 'string',
          description:
            'docx/pdf: simple HTML; md: Markdown source. Forbidden for xlsx/csv — their data comes from the worksheet',
        },
      },
      required: [],
    },
  },
];
export const sheetsActionInputSchema = {
 type: 'object',
 oneOf: sheetsActions.map(tool => ({
  type: 'object', properties: { documentId: { type: 'string', pattern: '^doc_[a-f0-9]{16}$' }, action: { const: tool.name }, input: tool.inputSchema },
  required: ['documentId', 'action', 'input'], additionalProperties: false
 }))
};
