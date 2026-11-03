import type { BrowserBackendMode } from '../manifest.js'

export function browserToolDescription(mode: BrowserBackendMode): string {
  const iab = mode === 'iab'
  return [
    iab
      ? `Control web pages in the Matcha in-app browser. Operate on web pages, not native desktop/mobile apps.`
      : `Control the user's Chrome via MatchaClaw Browser Relay extension. Use the extension relay by default; connectionMode="direct-cdp" is debug-only and must be explicitly requested. Operate on web pages, not native desktop/mobile apps.`,
    `Use the single browser tool: choose action; for interactions pass action="act" with request={kind,...}; for utilities pass action="utility" with request={kind,...}. Utility and interaction options go inside request.
**targetId is REQUIRED** for snapshot, screenshot, navigate, console, act — use the targetId from action=tabs (for existing tabs) or action=open (for new tabs). Prefer reusing existing tabs via action=tabs before opening new ones.`,
    `action="tabs"
List open browser tabs with their targetId, URL, and title.

WHEN: Use when the task should operate an existing page.
RULES:
  - Listing tabs does not choose a browser for a future action="open" call.
  - Returns tabs with { targetId, url, title }. Use targetId in subsequent calls.
EXAMPLE:
  {action:"tabs"} → {tabs:[{targetId:"page1", url:"https://example.com", ...}]}`,
    `action="snapshot"
Capture the current page as a fused accessibility tree with e* element refs for later interactions.

WHEN: Before act click/type/fill on new DOM state — snapshot first to learn refs.
RULES:
  - targetId is REQUIRED. Get it from action="tabs" or action="open".
  - The result is one fused tree. Use only e* refs that appear in the returned snapshot.
  - Refs are reused across snapshots for matching element identities — keep using a known e<n> ref unless the latest snapshot omits it. New identities get fresh ids above the previous max; removed identities' ids are retired (do not use them). Navigation invalidates the previous snapshot state.
  - Re-snapshot after navigation or any DOM-changing action before using newly rendered elements.
  - Supported element actions click/type/hover/select/scrollIntoView, fill fields, highlight and direct upload accept backendNodeId/frameId instead of ref when the snapshot is degraded. backendNodeId takes precedence over ref.
  - Output can be large; scan only the section relevant to the task.
  - If the snapshot is degraded, ${iab ? 'use a returned ref or backendNodeId from [dom=N] with its frameId for supported element actions' : 'use backendNodeId from [dom=N] with its frameId for supported element actions; do not reuse old e* refs'}. If actionPerformed=false and pageUpdated=true, inspect the updated snapshot before acting.
EXAMPLE:
  {action:"snapshot", targetId:"page1"}`,
    `action="screenshot"
Capture a screenshot of the page (PNG by default). Three scopes — pick one:
  · viewport     (default)   — whole visible area
  · element-by-ref (ref)     — crop to a specific element from action="snapshot"
  · element-by-css (element) — crop to element matched by CSS selector

WHEN: User asks to "see" the page, you need visual verification, or you want to crop to a specific widget.
RULES:
  - targetId is REQUIRED.
  - fullPage=true captures the full page without ref/element cropping. For content below the fold, action="scroll" first.
  - ref (preferred) and element are mutually exclusive with each other — pass at most one. If both are omitted, takes a full viewport screenshot unless fullPage=true.
  - Optional savePath saves the image to a workspace path.
EXAMPLE:
  {action:"screenshot", targetId:"page1"}                                   // viewport
  {action:"screenshot", targetId:"page1", ref:"e42"}                        // crop to element by ref
  {action:"screenshot", targetId:"page1", element:".pricing-card"}          // crop by CSS selector
  {action:"screenshot", targetId:"page1", savePath:"./shots/home.png", type:"jpeg"}`,
    `action="open"
Open a NEW tab at the given URL. Returns the new targetId.

WHEN: Use when the task needs a new page rather than a positively identified existing tab.
RULES:
  - url must be absolute (https://...). Omit it to open about:blank.
  - Set retain=true if user says "keep this open" or the page has valuable state (logged-in dashboard, multi-step form).
  - Also retain when the caller or user says "do not close" or "keep this tab open", or the page is one the caller is likely to revisit. Err on the side of retaining when the page has meaningful state.
  - Default retain=false: ordinary agent-opened tabs are auto-closed when the real root run ends, after in-flight operations drain. A leaf run ending only releases its claims. Pre-existing user tabs and retained tabs are preserved.
  - Retained tabs are exempt from agent close/stop/closeagenttabs and run cleanup. This does not promise persistence across application/browser restarts.
EXAMPLE:
  {action:"open", url:"https://example.com"}
  {action:"open", url:"https://app.example.com/dashboard", retain:true}
  {action:"open", url:"http://localhost:3000"}`,
    `action="navigate"
Navigate an EXISTING tab to a new URL.

WHEN: Reuse a tab to load a different page (faster than open + close).
RULES:
  - Both targetId and url are REQUIRED.
  - URL must be absolute.${iab ? ' Use HTTP/HTTPS without embedded credentials, or about:blank.' : ''}
EXAMPLE:
  {action:"navigate", targetId:"page1", url:"https://example.com/page2"}`,
    `action="focus"
Switch focus to a tab (bring to foreground).

WHEN: Multiple tabs are open and you need to interact with a specific one.
RULES:
  - targetId is REQUIRED. Get from action="tabs" or action="open".
EXAMPLE:
  {action:"focus", targetId:"page1"}`,
    `action="close" / action="closeagenttabs" (alias "close_agent_tabs")
Close a single eligible tab OR this executor's eligible agent-opened tabs.

WHEN: Free a tab slot mid-run. Most tabs auto-close at root run end — only call when actively needed.
RULES:
  - action="close" REQUIRES targetId.
  - action="closeagenttabs" closes this executor's non-retained tabs that are not claimed by another executor.
  - Cannot close pre-existing user tabs, retained tabs, tabs created by another executor, or tabs claimed by another executor.
EXAMPLE:
  {action:"close", targetId:"page1"}
  {action:"closeagenttabs"}
  Invalid: {action:"close"}  // missing targetId`,
    `action="act", request.kind="click" / "clickCoords"
Click an element by ref — or by viewport coordinates (Set-of-Mark / visual grounding).

WHEN: User wants a single mouse click on a specific element you found via action="snapshot".
RULES:
  - ref MUST come from a recent action="snapshot" result (pattern: e<n>).
  - OR use kind="clickCoords" and pass x,y (viewport CSS pixels) instead of ref — for marks from utility kind=som or visual bboxes (canvas / shadow DOM / cross-origin iframe).${iab ? ' A small random offset (±3px) plus hit-test is applied automatically.' : ''}
  - For double click, set doubleClick=true (do NOT call this twice).
  - For right click / middle click, set button="right" or "middle".
  - For modifier-keys (Shift-click for range select, Ctrl/Cmd-click for multi-select, Alt-click for open-in-new-tab), pass modifiers as an array.
EXAMPLE:
  {action:"act", targetId:"page1", request:{kind:"click", ref:"e42"}}
  {action:"act", targetId:"page1", request:{kind:"click", ref:"e7", doubleClick:true}}
  {action:"act", targetId:"page1", request:{kind:"clickCoords", x:342, y:517}}  // SoM mark center / visual bbox
  {action:"act", targetId:"page1", request:{kind:"click", ref:"e5", modifiers:["Shift"]}}  // Shift-click range select
  {action:"act", targetId:"page1", request:{kind:"click", ref:"e5", modifiers:["ControlOrMeta"]}}  // multi-select (Cmd on mac, Ctrl on win)
  Invalid: {action:"act", targetId:"page1", request:{kind:"click", ref:".btn-submit"}}  // a CSS selector is not a ref${iab ? '' : '\n  For a CSS target, use request.selector instead of ref.'}`,
    `action="act", request.kind="type"
Type text into a single input field by ref.

WHEN: Filling ONE field. For multiple fields in one form, use act kind="fill" instead (faster).
RULES:
  - ref MUST come from action="snapshot" (e<n>).
  - By default the field value is REPLACED (cleared first). Pass clearFirst=false ONLY to append to existing content.
  - submit=true submits the form after typing.
  - slowly=true types one character at a time (use ONLY for fields with per-keystroke JS validation — e.g. autocomplete, search-as-you-type; default is a single fast insertText).
EXAMPLE:
  {action:"act", targetId:"page1", request:{kind:"type", ref:"e5", text:"hello"}}
  {action:"act", targetId:"page1", request:{kind:"type", ref:"e3", text:"foo", submit:true}}
  {action:"act", targetId:"page1", request:{kind:"type", ref:"e8", text:"acme", slowly:true}}  // autocomplete picker needs each keystroke`,
    `action="act", request.kind="fill"
Fill multiple form fields in one call (much faster than multiple act kind="type" calls).

WHEN: Form has 2+ fields to fill at once.
RULES:
  - fields is REQUIRED, each item: {ref, value?, type?} (type defaults to "text").
  - type can be "text" / "select" / "checkbox" / "radio".
  - value is required for "text" and "select". For "checkbox" / "radio", value may be omitted (treated as unchecked / false).
  - All refs MUST come from action="snapshot".
EXAMPLE:
  ${iab
    ? '{action:"act", targetId:"page1", request:{kind:"fill", fields:[{ref:"e1", value:"alice"}, {ref:"e2", value:"alice@example.com"}, {ref:"e3", value:"medium", type:"select"}]}}'
    : '{action:"act", targetId:"page1", request:{kind:"fill", fields:[{ref:"e1", type:"text", value:"alice"}, {ref:"e2", type:"text", value:"alice@example.com"}, {ref:"e3", type:"checkbox", value:true}]}}'}`,
    `action="act", request.kind="press"
Press a keyboard key (without targeting any specific element).

WHEN: Need to send a global keypress (Escape, Enter, Tab, Ctrl+S, etc.) to the focused tab.
RULES:
  - key is REQUIRED. Use Playwright key syntax: "Enter", "Escape", "Tab", "ArrowDown", "Control+s", etc.
  - For typing into a specific input, use act kind="type" instead.
  - delayMs: wait this many ms between keydown and keyup — only needed for pages that animate key-repeat (rare).
EXAMPLE:
  {action:"act", targetId:"page1", request:{kind:"press", key:"Escape"}}
  {action:"act", targetId:"page1", request:{kind:"press", key:"Control+s"}}
  {action:"act", targetId:"page1", request:{kind:"press", key:"ArrowDown", delayMs:100}}`,
    `action="act" — other request kinds
Perform a less-common interaction: hover / select / resize / scrollIntoView / wait / evaluate / close page.

WHEN: For click/type/fill/press, use the corresponding request.kind. Use the kinds below for other interactions.
RULES:
  - request.kind MUST be one of: hover / select / resize / scrollIntoView / wait / evaluate / close / clickCoords / click / type / fill / press / drag / scroll${iab ? ' / hoverCoords / dragCoords / wheelCoords' : ''}.
  - Required fields per kind:
    * hover:           {ref}
    * select:          {ref, values:["option1",...]}  // multi-select supported
    * resize:          {width, height}  // page viewport
    * scrollIntoView:  {ref}
    * wait:            at least one of: timeMs, text (visible), textGone, selector, url, loadState, fn — plus optional timeoutMs (see wait rules below)
    * evaluate:        {fn} JS ${iab ? 'expression as string; invoke any function yourself. Optional frameId (from utility kind:"frames") evaluates inside that frame — cross-origin iframes (oopif:true) work too' : 'function/expression as string; optional ref evaluates fn on that element'}
    * clickCoords:     {x, y} viewport CSS pixel click${iab ? ' (SoM / visual grounding); optional button/doubleClick/modifiers/humanize' : ' (visual grounding); optional button/doubleClick/modifiers'}
    * close:           {} closes the page for this targetId (the tab/window), subject to the close ownership rules — not an HTML <dialog> dismiss. For native window.alert/confirm, use ${iab ? 'utility kind="dialog"' : 'action="dialog"'}; for in-page modals, prefer clicking a close control.
    * drag:            {startRef, endRef}  // drag between snapshot elements${iab ? '; alternatively startRef with endX/endY' : ''}
    * scroll:          {scrollDirection, scrollAmount?}  // same as action="scroll"${iab ? '\n    * hoverCoords:     {x, y, humanize?}  // hover at viewport CSS pixels\n    * dragCoords:      {from:{x,y}, to:{x,y}, steps?, durationMs?}  // coordinate drag\n    * wheelCoords:     {x, y, deltaX?, deltaY?, humanize?}  // wheel at viewport CSS pixels' : ''}
EXAMPLE:
  {action:"act", targetId:"page1", request:{kind:"hover", ref:"e5"}}
  {action:"act", targetId:"page1", request:{kind:"select", ref:"e3", values:["red","blue"]}}
  {action:"act", targetId:"page1", request:{kind:"clickCoords", x:342, y:517}}  // ${iab ? 'SoM mark center click' : 'visual bbox click'}`,
    `action="scroll"
Scroll the page: up, down, left, right, jump to top, or jump to bottom.

WHEN: Page has more content off-screen (e.g. after a viewport action="screenshot").
RULES:
  - scrollDirection MUST be: up / down / left / right / top / bottom.
  - For up/down/left/right, optional scrollAmount in pixels (default = 0.9× viewport height).
  - Returns {scrollY, scrollHeight, viewportHeight, atTop, atBottom} — atBottom is vertical-only; use for vertical lists.
  - If a page has more content below the viewport, scroll down then snapshot/screenshot again. Repeat until atBottom=true or the needed content is found.
EXAMPLE:
  {action:"scroll", targetId:"page1", scrollDirection:"down"}
  {action:"scroll", targetId:"page1", scrollDirection:"down", scrollAmount:500}
  {action:"scroll", targetId:"page1", scrollDirection:"left", scrollAmount:200}
  {action:"scroll", targetId:"page1", scrollDirection:"bottom"}`,
    `action="act", request.kind="wait"
Wait for a specific condition: time, element, visible text, text gone, URL, load state, or JS expression.

WHEN: Page is loading async content and you need to pause before next action.
RULES:
  - Pass request.kind="wait" and a condition field: timeMs / selector / text / textGone / url / loadState / fn.
  - Required field per condition:
    * time:       {timeMs}
    * element:    {selector}  // CSS selector until present in the document (not necessarily visible)
    * text:       {text}      // substring until present in document.body.innerText
    * textGone:   {textGone}  // until this text disappears from document.body.innerText
    * url:        {url}       // until location.href includes this substring
    * loadState:  {loadState: load|domcontentloaded|networkidle}  // prefer load by default; networkidle watches new requests during this wait until none remain and the network has been quiet for 500ms
    * fn:         {fn}        // truthy page JavaScript expression; invoke any function yourself
  - With multiple conditions, the first applies: positive timeMs, loadState, text, textGone, selector, url, fn.
  - Optional timeoutMs.
EXAMPLE:
  {action:"act", targetId:"page1", request:{kind:"wait", timeMs:2000}}
  {action:"act", targetId:"page1", request:{kind:"wait", selector:".loaded", timeoutMs:10000}}
  {action:"act", targetId:"page1", request:{kind:"wait", text:"Sign in", timeoutMs:10000}}
  {action:"act", targetId:"page1", request:{kind:"wait", loadState:"load"}}`,
    iab
      ? `action="console"
Evaluate a JavaScript expression OR read captured console.* messages from the page.

Two modes — pick ONE per call:
  MODE A (evaluate): pass expression or scriptPath → in-page JavaScript (Playwright page.evaluate-style; runs in the page context).
  MODE B (read logs): omit expression and scriptPath → returns recent console.log/warn/error messages (optionally filtered by level).

WHEN:
  - Mode A: read/compute something from page state (DOM query, localStorage check, ...).
  - Mode B: check whether the site logged warnings/errors that explain a failure.
RULES:
  - Mode A: expression MUST be an EXPRESSION, not a statement. Top-level \`return\` or \`await\` are INVALID. Wrap async in IIFE: \`(async () => { ... })()\`.
  - Mode A: for DEBUG output return {__debug:["msg1","msg2"], __result: yourValue} — only __result is saved.
  - Mode A: for long scripts, write to a workspace .js file first then use scriptPath.
  - Mode A: optional savePath saves return value as JSON to a workspace path.
  - Mode A: optional frameId (from utility kind:"frames") evaluates inside that frame instead of the main document — cross-origin iframes (oopif:true) work too.
  - Mode B: level filters by "log" / "info" / "warn" / "error" / "debug". Omit to get all.
  - Return value can be any JSON-serializable value.
EXAMPLE:
  {action:"console", targetId:"page1", expression:"document.title"}
  {action:"console", targetId:"page1", expression:"(() => Array.from(document.querySelectorAll('.item')).map(e=>e.textContent))()"}
  {action:"console", targetId:"page1"}                             // Mode B: all console messages
  {action:"console", targetId:"page1", level:"error"}              // Mode B: only errors
  {action:"console", targetId:"page1", frameId:"A1B2…", expression:"document.title"}  // inside one frame
  Invalid: {action:"console", targetId:"page1", expression:"return document.title"}  // top-level return is INVALID`
      : `action="console"
Evaluate a JavaScript expression OR read captured console.* messages from the page.

Two modes — pick ONE per call:
  MODE A (evaluate): pass expression or scriptPath → in-page JavaScript.
  MODE B (read logs): omit expression and scriptPath → returns recent console.log/warn/error messages (optionally filtered by level).

WHEN:
  - Mode A: read/compute something from page state (DOM query, localStorage check, ...).
  - Mode B: check whether the site logged warnings/errors that explain a failure.
RULES:
  - targetId is REQUIRED.
  - Mode A: expression MUST be an EXPRESSION, not a statement. Top-level \`return\` or \`await\` are INVALID. Wrap async in IIFE: \`(async () => { ... })()\`.
  - Mode A: for DEBUG output return {__debug:["msg1","msg2"], __result: yourValue} — only __result is saved.
  - Mode A: for long scripts, write to a workspace .js file first then use scriptPath.
  - Mode A: optional savePath saves return value as JSON to a workspace path.
  - Mode A: optional frameId evaluates inside that native frame instead of the main document, including cross-origin frames.
  - Mode B: level filters by "log" / "info" / "warn" / "error" / "debug". Omit to get all.
  - Return value can be any JSON-serializable value.
EXAMPLE:
  {action:"console", targetId:"page1", expression:"document.title"}
  {action:"console", targetId:"page1", expression:"(() => Array.from(document.querySelectorAll('.item')).map(e=>e.textContent))()"}
  {action:"console", targetId:"page1"}                             // Mode B: all console messages
  {action:"console", targetId:"page1", level:"error"}              // Mode B: only errors
  Invalid: {action:"console", targetId:"page1", expression:"return document.title"}  // top-level return is INVALID`,
    `action="storage"
Read or write localStorage / sessionStorage entries.

WHEN: Need to inspect or seed storage (e.g. test login state, set feature flag).
RULES:
  - storageType: "local", "session"${iab ? ' or "indexedDB"' : ''}.
  - operation: "get" / "set" / "clear"${iab ? ' / "remove"' : ''}.
  - For set: key + value REQUIRED.
  - For get: key is optional — with key, returns that entry's value; without key, returns an object of all key→value for that storage.
  - For clear: always clears the entire local or session store for that origin (Storage#clear). key is ignored if passed.${iab ? '\n  - storageType "indexedDB": key = database name. get without key lists databases; get with key dumps every object store ({name, version, stores:{<store>:{keyPath, count, records[]}}}, max 20 records/store); set value is JSON {"store":"<name>","data":<record|records[]>}; remove value is JSON {"store":s,"key":k} (delete record) / {"store":s} (clear store) / no value (delete database).' : ''}
EXAMPLE:
  {action:"storage", targetId:"page1", storageType:"local", operation:"set", key:"user", value:"alice"}
  {action:"storage", targetId:"page1", storageType:"local", operation:"get", key:"user"}
  {action:"storage", targetId:"page1", storageType:"session", operation:"clear"}${iab ? '\n  {action:"storage", targetId:"page1", storageType:"indexedDB", operation:"get"}                      // list databases\n  {action:"storage", targetId:"page1", storageType:"indexedDB", operation:"get", key:"myapp"}          // dump stores+records' : ''}`,
    `action="utility"
Misc browser operations: highlight an element / upload files / handle dialogs / read errors / read page events / read network requests / generate PDF / get cookies / list frames / inspect JS scripts / resolve sourcemaps / export HAR / capture downloads / runtime tuning (pace + humanize + stealth).

WHEN: One of the niche operations below.
RULES:
  - request.kind MUST be one of: highlight / upload / dialog / errors / events / requests / pdf / cookies / frames / scripts / sourceMap / har / download / settings / som / intercept / metrics / emulate / a11yTree / domTree / goBack / goForward / reload.
  - Required fields per kind (inside request):
    * highlight: {ref, durationMs?}  // visually highlight an element by ref for debugging
    * upload:    {paths:[...], and ONE of inputRef | element | ref}  // paths must be in workspace
                 · inputRef (e<n>) — direct set on an <input type=file>
                 · element (CSS)  — same as inputRef but by selector
                 · ref (e<n>)     — click-triggered: ref points at the BUTTON that opens the native file dialog (styled "upload" buttons)
    * dialog:    {accept:bool, promptText?}  // pre-arm BEFORE the action that opens the dialog
    * errors:    {clear?:bool}  // read JS exceptions; pass clear=true to clear after reading
    * events:    {filter?, since?, clear?}  // discrete page events: dialog (with the answer given) / fileChooser / rendererCrash — filter by kind, since = exclusive seq cursor
    * requests:  {filter?:string, clear?:bool, last?:number}  // ${iab ? 'read network log (request/response headers, POST bodies and bounded response bodies); WebSocket frames are in events. filter matches captured entry text; clear=true clears after reading' : 'read captured network requests (up to 500 entries); filter is a URL substring; clear=true clears after reading. This does not capture POST or response bodies'}
    * pdf:       {savePath?:string}  // generate a PDF of the page
    * cookies:   {operation:"get"|"set"|"clear", cookies?:[...]}  // pass cookies array for set
    * frames:    {}  // list every frame of the document: {frameId, url, oopif} — cross-origin iframes carry oopif:true; pass a frameId to console/act(evaluate) to read inside a frame
    * scripts:   {filter?:string, includeSource?:bool, limit?:number, maxChars?:number}  // list parsed JS scripts (url/hash/sourceMappingURL); includeSource requires a filter (128KB cap, maxChars up to 1MB)
    * sourceMap: {scriptId? | filter?, line?, column?}  // map minified line/column (1-based) back to original source {source, line, column, sourceLineText}; no line → the map's sources list
    * har:       {savePath, filter?, last?, clear?}  // export captured request/response traffic as HAR 1.2 into the workspace; savePath is REQUIRED; clear=true clears only after saving successfully
    * download:  ${iab ? '{savePath? | dir?, timeoutMs?, trigger?}  // arm-and-wait for a download → {url, savePath, bytes}; default timeout 60s.' : '{savePath? | dir?, timeoutMs?, trigger?}  // arm-and-wait for one download, then save its original file; default timeout 60s.'} Prefer trigger:{kind:"click",ref:"e42"} or {kind:"clickCoords",x:342,y:517}: the watch is armed BEFORE the click. Without trigger, arm before the external/user action; do not issue the download click first and watch afterward
    * settings:  {settings?}  // GET (omit settings) or SET per-tab runtime tuning — pace: {minIntervalMs, jitterMs?} min gap between acts (null=off) / humanize: true random trajectories+keystrokes (null=off) / stealth: {enabled:true} anti-fingerprint injection (navigator.webdriver/plugins/languages/permissions/chrome); stealth stays enabled until tab close; all default OFF, zero cost when off
    * som:       {mode?:"dom"|"vision", maxMarks?, selector?, screenshot?}  // Set-of-Mark. dom (default): screenshot with numbered labels on visible clickable elements + marks table {id,x,y,width,height,tag,text,role} (viewport CSS px) — click via act kind="clickCoords" {x,y} at mark center. vision: clean screenshot + viewport size for visual grounding (canvas/shadow-DOM/cross-origin-iframe targets the ref system cannot reach)
    * intercept: {rules?:[{pattern, match?, action:"block"|"mock"|"modify"|"continue", status?, headers?, body?, contentType?, method?}], clear?, cacheBypass?}  // Fetch-domain request interception; pattern is a URL substring, or a glob with match="glob"; rules persist per tab until cleared; cacheBypass also sets Network.setCacheDisabled
    * metrics:   {}  // Performance.getMetrics snapshot: JSHeapUsedSize/LayoutDuration/ScriptDuration/Nodes/... (Performance.enable + getMetrics)
    * emulate:   {action:"device"|"timezone"|"locale"|"geolocation"|"colorScheme"|"userAgent"|"network"|"cpu", ...params, clear?}  // emulation overrides — e.g. {action:"locale", locale:"zh-CN"} / {action:"timezone", timezoneId:"Asia/Shanghai", clear:true} / {action:"network", preset:"Slow 3G"} / {action:"cpu", rate:4}
    * a11yTree:  {text?, max?}  // read the raw accessibility tree
    * domTree:   {scope?, text?, max?, depth?, deepText?, includeHrefInFilter?}  // read the raw DOM tree; scope is a CSS selector
    * goBack:    {}  // navigate to the previous history entry
    * goForward: {}  // navigate to the next history entry
    * reload:    {ignoreCache?}  // reload the current page
  - highlight/upload/dialog/errors/requests/pdf/cookies are also direct actions: use action equal to the kind and put its fields at the top level.
  - Optional savePath must be under workspace.${iab ? '' : '\n  - Download defaults to the trusted workspace/downloads directory. Optional savePath or dir must stay in that workspace and are mutually exclusive; name collisions get a unique filename, never overwrite.\n  - Requires the extension relay and a uniquely discovered local profile. Saves the completed original file from its allowed download directory, not a second GET of the URL. No remote file transfer or Save As outside that directory; browserFilePath alone is not file access authority.\n  - Returns the original download and triggerOutcome; downloadState="completed" means browser completion, while saveOutcome="saved"|"failed"|"unknown" describes workspace saving. A saved file includes savePath/fileName/bytes. Inspect both outcomes; never automatically repeat the click after a save failure. Attribution remains a browser time window, not proof that this tab caused the download.'}
EXAMPLE:
  {action:"utility", targetId:"page1", request:{kind:"highlight", ref:"e5", durationMs:2000}}
  {action:"utility", targetId:"page1", request:{kind:"upload", paths:["./file.pdf"], inputRef:"e3"}}  // direct <input>
  {action:"utility", targetId:"page1", request:{kind:"upload", paths:["./file.pdf"], ref:"e42"}}  // styled button — click-triggered
  {action:"utility", targetId:"page1", request:{kind:"dialog", accept:true}}
  {action:"utility", targetId:"page1", request:{kind:"errors", clear:true}}
  {action:"utility", targetId:"page1", request:{kind:"frames"}}  // frame inventory (OOPIF marked)
  {action:"utility", targetId:"page1", request:{kind:"scripts", filter:"app.js", includeSource:true}}  // JS source of one bundle${iab ? '' : '\n  {action:"highlight", targetId:"page1", ref:"e5", durationMs:2000}\n  {action:"upload", targetId:"page1", paths:["./file.pdf"], inputRef:"e3"}  // direct <input>\n  {action:"dialog", targetId:"page1", accept:true}\n  {action:"errors", targetId:"page1", clear:true}\n  {action:"utility", targetId:"page1", request:{kind:"download", trigger:{kind:"click",ref:"e42"}}}'}`,
    `Other actions:
  - status: read backend readiness.
  - start: prepare/check the selected backend.
  - profiles: list available browser profiles.
  - stop: close this executor's eligible temporary tabs and release its claims; preserve user/retained tabs.`,
    `Observation and interaction
Prefer semantic interaction:
1. action="snapshot"
2. obtain fresh ref${iab ? ' or backendNodeId' : ''}
3. call action="act" with click, type, fill, press, or related request kinds
4. verify the resulting URL, DOM, value, file, or page state

Do not reuse node evidence after navigation or DOM replacement.
Never use visual fallback for CAPTCHA or access-control bypasses.

Safety and results
Use URLs supplied by the task or observed from the current page. Do not invent endpoints, signed parameters, or opaque tokens.
Do not inspect storage or cookies for credentials.
Browser calls that share a tab should run sequentially.
A successful primitive call proves execution, not business success. Verify outcomes explicitly.
Return one compact JSON-compatible result containing:
- status or ok
- requested structured data
- milestone completeness
- evidence URLs, screenshots, or files
- blockers or failures
Login, CAPTCHA, access denial, qualification gates, persistent 403/429 responses, and unsupported regions are blockers. Preserve partial evidence and stop instead of repeatedly retrying.`,
  ].join('\n\n')
}
