// Schemas copied from the pinned Slides TOOLS; execution stays in createSlidesSkill.
const actions = [
{
    name: 'execute_slide_script',
    description:
      "[Preferred tool for editing a slide's existing elements] Runs your JS edit script against one page; a single script covers: position/size/alignment/distribution/relative nudges/text/style/fill/stroke." +
      ' At run time the script automatically receives the real geometry and text of every element on the page (els) — **no read_slide needed first**; read-write combined, compute from els inside the script.' +
      ' The whole script is one atomic transaction: geometry in one batch, the rest in script order, one undo step; if any operation fails, everything rolls back and the page is unchanged — fix the script and resend it whole. A layout audit (overlap/out-of-bounds/text overflow) is returned at the end.' +
      ' Far more reliable than individual set_element_* calls — coordinate math happens at execution site, not from memory. If the audit reports problems, call this tool again immediately to fix.\n' +
      'Script environment (constrained synchronous JS-like DSL; no external APIs or ambient globals):\n' +
      '- els: array, each item {id,type,text,x,y,w,h,rotation,fontSizePt?,fill?,textColor?,strokeColor?,inGroup?,groupId?,locked?} (pixels, origin top-left; fill/textColor/strokeColor are current colors in #RRGGBB, read-only — write via setFill/setStyle/setStroke; inGroup+groupId=directly editable group child (all primitives work, coordinates absolute as shown); inGroup without groupId=nested in a sub-group, read-only — apply_ops ungroupElement on the outer group first; locked=layout decoration, read-only)\n' +
      '- canvas: {w,h} canvas size (px)\n' +
      "- setBox(id, {x?,y?,w?,h?,rotation?}): set an element's target box, pass only fields to change\n" +
      '- moveBy(id, dx, dy): relative move (left = negative dx, up = negative dy)\n' +
      '- resizeBy(id, dw, dh): relative resize\n' +
      '- setText(id, textOrParagraphs): replace text entirely; pass a string (split into paragraphs by \\n) or a paragraph array (same format as apply_ops setText paragraphs). Plain runs/strings inherit the original size, color and font — do not add fontSize/color/fontFamily unless the user asked to restyle\n' +
      '- setStyle(id, {fontSize?,color?,bold?,italic?,underline?,align?,fontFamily?}): change style without changing text, pass only fields to change\n' +
      "- setFill(id, colorOrNone): solid fill '#RRGGBB' or 'none'\n" +
      '- setStroke(id, {color?,widthPt?} | null): stroke; pass null to remove\n' +
      '- log(...): debug output (echoed back to you); the return value is echoed back to you (put a summary there)\n' +
      '- Supported computation: const/let, arithmetic, if/for/for...of/while, functions/arrows, JSON object/array literals, Math, regex.test, and safe array/string methods. No classes, async, modules, constructors, prototypes, or dynamic code.\n' +
      'Example 1 — three cards equal width, equal spacing:\n' +
      'const cards = els.filter(e => /card/.test(e.id));\n' +
      'const gap = 32, w = (canvas.w - 2*80 - (cards.length-1)*gap) / cards.length;\n' +
      'cards.forEach((c, i) => setBox(c.id, { x: 80 + i*(w+gap), y: 200, w, h: 320 }));\n' +
      "Example 2 — move the title left a bit: moveBy('title', -30, 0);\n" +
      "Example 3 — make the title blue and bold: setStyle('t1', { color: '#1a73e8', bold: true });",
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page number (0-based)' },
        code: {
          type: 'string',
          description:
            'JS script body (synchronous code; may use els/canvas plus setBox/moveBy/resizeBy/setText/setStyle/setFill/setStroke/log; may return a summary)',
        },
        explanation: {
          type: 'string',
          description:
            'One sentence describing what this script does (≤60 chars, shown to the user)',
        },
      },
      required: ['slideIndex', 'code'],
    },
  },
{
    name: 'insert_web_image',
    description:
      'Download an image URL obtained from image_search or generate_image and insert it into a page (pixel coordinates). w×h is a layout frame, not a stretch target: the image keeps its aspect ratio, fills the frame, and the overflow is center-cropped (object-fit: cover) — pick the frame for the layout freely. ' +
      'To place an image the USER ATTACHED (logo, photo, screenshot), pass url=attachment://<file name> (the exact name from the attachment list) — the app embeds the original file bytes as-is. Never recreate an attached image with generate_image and never ask for base64.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        url: {
          type: 'string',
          description:
            'Direct image link (imageUrl from image_search), or attachment://<file name> to embed a user-attached image as-is',
        },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['slideIndex', 'url', 'x', 'y', 'w', 'h'],
    },
  },
{
    name: 'replace_image',
    description:
      'Swap a picture\'s source image for a URL (from image_search or generate_image) in place — position, size, z-order, border and effects all survive. This is the tool for "change/AI-edit this image" flows: e.g. run generate_image with referenceImageUrls for background removal/upscaling/editing, then replace_image with the returned URL. A new image with a different aspect ratio is never stretched: it fills the frame and is center-cropped (object-fit: cover). keepCrop keeps the existing crop window and is only correct when the new image has the same pixel geometry as the old one (e.g. background removal output).',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string', description: 'Picture element id' },
        url: { type: 'string', description: 'Direct image link' },
        keepCrop: { type: 'boolean', description: 'Keep the existing crop window (default false)' },
      },
      required: ['slideIndex', 'sourceId', 'url'],
    },
  }
];
export const slidesActions = [...actions, { ...actions[0]!, name: "execute_layout_script" }];
export const slidesActionSchema = {
  type: "object", required: ["documentId", "action", "input"], additionalProperties: false,
  properties: { documentId: { type: "string", pattern: "^doc_[a-f0-9]{16}$" }, action: { type: "string", enum: slidesActions.map(action => action.name) }, input: { type: "object" } },
  oneOf: slidesActions.map(action => ({ properties: { action: { const: action.name }, input: action.inputSchema } })),
};
