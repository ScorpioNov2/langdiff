/**
 * Langdiff — bilingual markdown diff viewer.
 *
 * Performance architecture:
 * - The editable input itself is virtualized. The full document lives in a
 *   plain `documentLines` array (the source of truth); the real, native
 *   `<textarea>` the user actually types into only ever holds a "window" of
 *   up to ~1800 lines around the current scroll position (centered, with a
 *   generous buffer on each side). Scrolling near the edge of the loaded
 *   window swaps in a new slice of `documentLines` and compensates
 *   `scrollTop` so the swap is visually seamless, even under a fast
 *   fling-scroll. This is what keeps typing (and, critically, IME
 *   composition for scripts like Vietnamese Telex, which is far more
 *   sensitive to textarea size than plain character input) fast regardless
 *   of total document size: the browser's own internal textarea layout
 *   only ever has to deal with a bounded window, never the whole document.
 *   Known trade-offs of this approach vs. a full custom editor: the
 *   textarea's native scrollbar thumb reflects the loaded window, not the
 *   true document proportions (cosmetic only - the gutter's line numbers
 *   are always exact); native undo/redo history does not persist across a
 *   window swap; Ctrl+Home/End and "select all -> copy" are special-cased
 *   to operate on the whole document, but a manual selection that happens
 *   to span exactly one full window is (rarely) treated the same way.
 * - The input gutter (line numbers) is virtualized the same way it always
 *   was: only DOM nodes for visible lines (plus a small buffer), positioned
 *   with a single `transform`.
 * - The diff viewer (right panel) is also virtualized. Because rows can wrap
 *   (word-break: break-all) their heights vary, so instead of measuring every
 *   row with the DOM (which would not scale to hundreds of thousands of rows),
 *   we compute wrapped height analytically: since the font is monospace, the
 *   number of visual lines a row occupies is `ceil(text.length / charsPerLine)`.
 *   That gives an O(n) pass to build a cumulative offset table once per render,
 *   and O(log n) binary search per scroll frame to find the visible window.
 *   Because charsPerLine depends on the viewer's pixel width, anything that
 *   changes that width (a window resize, or toggling the input panel closed
 *   so the viewer expands to fill the screen) must recompute this table -
 *   otherwise rows re-wrap visually (the browser just reflows the text) but
 *   the row's own height/position stays sized for the old width, leaving
 *   stale background/spacing.
 */

import { createEditor, LANGUAGES, type LangId } from "./editor";
import { icon, withIcon } from "./icons";

const LINE_HEIGHT_PX = 21; // 14px * 1.5 line-height, matches the CSS below
const VIEWER_BUFFER_PX = 400;
const MONO_FONT =
  "500 14px ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";
const NUM_FONT =
  "500 13px ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";
const STORAGE_KEY = "langdiff_content";

type LineType = "normal" | "minus" | "plus" | "file" | "hunk" | "meta" | "noeol" | "split" | "chunk";
type ParseMode = "auto" | "bilingual" | "patch" | "compare";
const MODE_KEY = "langdiff_mode";

interface DiffLine {
  type: LineType;
  oldNum: number | "";
  newNum: number | "";
  content: string;
  file?: number;
  parts?: [string, boolean][];
  chunk?: number;
  left?: DiffLine;
  right?: DiffLine;
}

interface FileInfo {
  name: string;
  status: "A" | "D" | "M" | "R";
  added: number;
  removed: number;
  firstRow: number;
}

function measureCharWidth(): number {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = MONO_FONT;
  const sample = "M".repeat(64);
  return ctx.measureText(sample).width / 64;
}

function measureNumCharWidth(): number {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = NUM_FONT;
  const sample = "0".repeat(64);
  return ctx.measureText(sample).width / 64;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface PatchStats {
  files: number;
  hunks: number;
  added: number;
  removed: number;
}

/** Original bilingual rule: "- " / "+ " rows, counters run across the whole text. */
function parseBilingual(lines: string[]): DiffLine[] {
  const result: DiffLine[] = new Array(lines.length);
  let oldLineNum = 1;
  let newLineNum = 1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].replace(/[\r\n]/g, "").trimEnd();
    let type: LineType = "normal";
    let content: string;
    let oldNum: number | "" = "";
    let newNum: number | "" = "";

    if (trimmed.startsWith("-")) {
      type = "minus";
      content = trimmed.replace(/^- ?/, "");
      oldNum = oldLineNum;
      oldLineNum++;
    } else if (trimmed.startsWith("+")) {
      type = "plus";
      content = trimmed.replace(/^\+ ?/, "");
      newNum = newLineNum;
      newLineNum++;
    } else {
      content = trimmed.startsWith("  ") ? trimmed.substring(2) : trimmed;
      oldNum = oldLineNum;
      newNum = newLineNum;
      oldLineNum++;
      newLineNum++;
    }

    result[i] = { type, oldNum, newNum, content };
  }
  return result;
}

function looksLikePatch(lines: string[]): boolean {
  const limit = Math.min(lines.length, 3000);
  for (let i = 0; i < limit; i++) {
    if (lines[i].startsWith("diff --git ") || HUNK_RE.test(lines[i])) return true;
  }
  return false;
}

function stripPathPrefix(p: string): string {
  return p.replace(/\t.*$/, "").replace(/^[ab]\//, "");
}

/**
 * Unified / git patch parser. Always returns exactly one row per input line so
 * that search and go-to-line keep mapping editor lines to viewer rows 1:1.
 * Hunk bodies are delimited by the counts in the "@@ -a,b +c,d @@" header, which
 * is what lets a removed line like "-- foo" (shown as "--- foo") be told apart
 * from a real "--- a/file" header.
 */
function parsePatch(lines: string[]): { lines: DiffLine[]; stats: PatchStats; files: FileInfo[] } {
  const out: DiffLine[] = new Array(lines.length);
  const stats: PatchStats = { files: 0, hunks: 0, added: 0, removed: 0 };
  const files: FileInfo[] = [];
  let cur: FileInfo | null = null;
  let oldN = 0;
  let newN = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let inGitHeader = false;
  let pendingMinusHeader = false;

  const row = (
    i: number,
    type: LineType,
    content: string,
    oldNum: number | "" = "",
    newNum: number | "" = "",
  ) => {
    out[i] = { type, oldNum, newNum, content, file: files.length - 1 };
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
    const inBody = oldLeft > 0 || newLeft > 0;
    const wasMinusHeader = pendingMinusHeader;
    pendingMinusHeader = false;

    if (raw.startsWith("\\")) {
      row(i, "noeol", raw.replace(/^\\ ?/, ""));
      continue;
    }

    if (raw.startsWith("diff ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
      stats.files++;
      inGitHeader = true;
      oldLeft = newLeft = 0;
      cur = { name: m ? m[2] : raw, status: "M", added: 0, removed: 0, firstRow: i };
      files.push(cur);
      row(i, "file", m ? (m[1] === m[2] ? m[1] : `${m[1]} \u2192 ${m[2]}`) : raw);
      continue;
    }

    const hm = HUNK_RE.exec(raw);
    if (hm) {
      oldN = parseInt(hm[1], 10);
      oldLeft = hm[2] === undefined ? 1 : parseInt(hm[2], 10);
      newN = parseInt(hm[3], 10);
      newLeft = hm[4] === undefined ? 1 : parseInt(hm[4], 10);
      stats.hunks++;
      inGitHeader = false;
      row(i, "hunk", raw);
      continue;
    }

    if (
      raw.startsWith("--- ") &&
      (lines[i + 1] ?? "").startsWith("+++ ") &&
      (!inBody || (lines[i + 2] ?? "").startsWith("@@"))
    ) {
      oldLeft = newLeft = 0;
      pendingMinusHeader = true;
      row(i, "meta", raw);
      continue;
    }

    if (wasMinusHeader && raw.startsWith("+++ ")) {
      if (inGitHeader) {
        row(i, "meta", raw);
      } else {
        // Plain unified diff without a "diff --git" line: "+++" names the file.
        stats.files++;
        cur = { name: stripPathPrefix(raw.slice(4)), status: "M", added: 0, removed: 0, firstRow: i };
        files.push(cur);
        row(i, "file", cur.name);
      }
      continue;
    }

    if (inBody) {
      const c = raw[0];
      if (c === "+") {
        row(i, "plus", raw.slice(1), "", newN++);
        newLeft = Math.max(0, newLeft - 1);
        stats.added++;
        if (cur) cur.added++;
        continue;
      }
      if (c === "-") {
        row(i, "minus", raw.slice(1), oldN++, "");
        oldLeft = Math.max(0, oldLeft - 1);
        stats.removed++;
        if (cur) cur.removed++;
        continue;
      }
      if (c === " " || raw === "") {
        row(i, "normal", raw.slice(1), oldN++, newN++);
        oldLeft = Math.max(0, oldLeft - 1);
        newLeft = Math.max(0, newLeft - 1);
        continue;
      }
      oldLeft = newLeft = 0; // truncated or hand-edited hunk: fall through
    }

    // index/mode/rename/Binary lines, commit message, diffstat, trailing blank...
    if (cur) {
      if (raw.startsWith("new file mode")) cur.status = "A";
      else if (raw.startsWith("deleted file mode")) cur.status = "D";
      else if (raw.startsWith("rename from")) cur.status = "R";
    }
    row(i, "meta", raw);
  }
  const kept = (ps: Part[]) => ps.reduce((n, x) => n + (x[1] ? 0 : x[0].length), 0);
  for (let i = 0; i < out.length; ) {
    if (out[i].type !== "minus") { i++; continue; }
    let m = i;
    while (m < out.length && out[m].type === "minus") m++;
    let p = m;
    while (p < out.length && out[p].type === "plus") p++;
    const n = Math.min(m - i, p - m);
    if (n <= 2000) {
      for (let k = 0; k < n; k++) {
        const a = out[i + k];
        const b = out[m + k];
        const wp = wordParts(a.content, b.content);
        // Only highlight pairs that are clearly the same line edited, not unrelated lines.
        if (wp && kept(wp[0]) >= 0.4 * Math.max(a.content.length, b.content.length)) {
          a.parts = wp[0];
          b.parts = wp[1];
        }
      }
    }
    i = Math.max(p, i + 1);
  }
  return { lines: out, stats, files };
}

const SEP_RE = /^={3}\s*$/;
const TOKEN_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const KW_RE = /\b(?:const|let|var|function|return|if|else|for|while|import|export|from|class|new|async|await|def|fn|pub|use|struct|enum|impl|interface|type|extends|try|catch|throw|switch|case|break|continue|true|false|null|undefined|None|True|False|self|this)\b/g;
type Part = [string, boolean];
type Op = ["=" | "-" | "+", number, number];

/** LCS diff of two sequences (common prefix/suffix trimmed, DP in the middle). */
function diffSeq(a: string[], b: string[]): Op[] {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const ops: Op[] = [];
  for (let i = 0; i < s; i++) ops.push(["=", i, i]);
  const n = ea - s;
  const m = eb - s;
  if (n * m > 4e6) {
    for (let i = s; i < ea; i++) ops.push(["-", i, -1]);
    for (let j = s; j < eb; j++) ops.push(["+", -1, j]);
  } else {
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i * w + j] = a[s + i] === b[s + j]
          ? L[(i + 1) * w + j + 1] + 1
          : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[s + i] === b[s + j]) { ops.push(["=", s + i, s + j]); i++; j++; }
      else if (i < n && (j === m || L[(i + 1) * w + j] >= L[i * w + j + 1])) { ops.push(["-", s + i, -1]); i++; }
      else { ops.push(["+", -1, s + j]); j++; }
    }
  }
  for (let k = 0; k < a.length - ea; k++) ops.push(["=", ea + k, eb + k]);
  return ops;
}

/** Word-level highlight spans for one removed/added line pair. */
function wordParts(a: string, b: string): [Part[], Part[]] | null {
  const ta = a.match(TOKEN_RE) ?? [];
  const tb = b.match(TOKEN_RE) ?? [];
  if (ta.length > 400 || tb.length > 400) return null;
  const pa: Part[] = [];
  const pb: Part[] = [];
  const push = (arr: Part[], t: string, ch: boolean) => {
    const last = arr[arr.length - 1];
    if (last && last[1] === ch) last[0] += t;
    else arr.push([t, ch]);
  };
  for (const [k, i, j] of diffSeq(ta, tb)) {
    if (k === "=") { push(pa, ta[i], false); push(pb, tb[j], false); }
    else if (k === "-") push(pa, ta[i], true);
    else push(pb, tb[j], true);
  }
  return [pa, pb];
}

function buildCompare(A: string[], B: string[]): DiffLine[] {
  const ops = diffSeq(A, B);
  const out: DiffLine[] = [];
  let o = 1;
  let n = 1;
  let chunks = 0;
  for (let k = 0; k < ops.length; ) {
    if (ops[k][0] === "=") {
      out.push({ type: "normal", oldNum: o++, newNum: n++, content: A[ops[k][1]] });
      k++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (k < ops.length && ops[k][0] !== "=") {
      if (ops[k][0] === "-") dels.push(ops[k][1]);
      else adds.push(ops[k][2]);
      k++;
    }
    const dRows = dels.map((i) => ({ type: "minus", oldNum: o++, newNum: "", content: A[i] }) as DiffLine);
    const aRows = adds.map((j) => ({ type: "plus", oldNum: "", newNum: n++, content: B[j] }) as DiffLine);
    for (let p = 0; p < Math.min(dRows.length, aRows.length); p++) {
      const wp = wordParts(dRows[p].content, aRows[p].content);
      if (wp) { dRows[p].parts = wp[0]; aRows[p].parts = wp[1]; }
    }
    const chunkId = chunks++;
    for (const r of dRows) { r.chunk = chunkId; out.push(r); }
    for (const r of aRows) { r.chunk = chunkId; out.push(r); }
  }
  return out;
}

/** Insert a "Change N" header row before each changed block (carries the A/B choice). */
function withHeaders(rows: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  for (let i = 0; i < rows.length; ) {
    const c = rows[i].chunk;
    if (c === undefined) { out.push(rows[i++]); continue; }
    let j = i;
    let m = 0;
    let p = 0;
    while (j < rows.length && rows[j].chunk === c) {
      if (rows[j].type === "minus") m++;
      else p++;
      j++;
    }
    out.push({ type: "chunk", oldNum: "", newNum: "", content: `Change ${c + 1} \u00b7 \u2212${m} +${p}`, chunk: c });
    for (; i < j; i++) out.push(rows[i]);
  }
  return out;
}

/** Pair removed/added rows into side-by-side rows. */
function toSplit(rows: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  const mk = (left?: DiffLine, right?: DiffLine): DiffLine => ({ type: "split", oldNum: "", newNum: "", content: "", left, right });
  for (let i = 0; i < rows.length; ) {
    if (rows[i].type === "chunk") { out.push(rows[i]); i++; continue; }
    if (rows[i].type === "normal") { out.push(mk(rows[i], rows[i])); i++; continue; }
    const m: DiffLine[] = [];
    const p: DiffLine[] = [];
    while (i < rows.length && rows[i].type === "minus") m.push(rows[i++]);
    while (i < rows.length && rows[i].type === "plus") p.push(rows[i++]);
    for (let k = 0; k < Math.max(m.length, p.length); k++) out.push(mk(m[k], p[k]));
  }
  return out;
}

/** Per-character class: 0 none, 1 comment, 2 string, 3 number, 4 keyword. */
function syntaxClasses(text: string): Uint8Array {
  const c = new Uint8Array(text.length);
  const mark = (re: RegExp, v: number) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      c.fill(v, m.index, m.index + m[0].length);
      if (m[0].length === 0) re.lastIndex++;
    }
  };
  mark(KW_RE, 4);
  mark(/\b\d[\d_.xa-fA-F]*\b/g, 3);
  mark(/"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?/g, 2);
  mark(/\/\/.*$|#.*$/g, 1);
  return c;
}

export function initLangdiff(root: HTMLElement) {
  root.innerHTML = `
    <div class="ld-drag-overlay">Drop file here to load into Langdiff</div>
    <header class="ld-header">
      <div class="ld-brand">
        ${icon("file", 18)}
        <span>Langdiff</span>
      </div>
      <div class="ld-controls">
        <div class="ld-controls-main">
        <button class="ld-btn" id="ld-theme-btn" title="Editor theme" data-testid="button-theme">${withIcon("sun", "Theme: Light")}</button>
        <button class="ld-btn ld-cmp-only" id="ld-split-btn" data-testid="button-split-view">${withIcon("columns", "Split view")}</button>
        <button class="ld-btn ld-cmp-only" id="ld-syntax-btn" data-testid="button-syntax">${withIcon("code", "Syntax: off")}</button>
        <button class="ld-btn" id="ld-find-btn" data-testid="button-find">
          ${icon("search")}
          <span>Find</span>
        </button>
        <button class="ld-btn" id="ld-usage-btn" data-testid="button-usage">
          ${icon("help")}
          <span>Usage</span>
        </button>
        <div class="ld-file-wrapper">
          <button class="ld-btn" data-testid="button-choose-file">
            ${icon("upload")}
            <span>Choose File</span>
          </button>
          <input type="file" id="ld-file-picker" accept=".txt,.md,.patch,.diff" data-testid="input-file-picker">
        </div>
        <button class="ld-btn" id="ld-toggle-input" data-testid="button-toggle-input">
          ${icon("panel")}
          <span>Toggle Input</span>
        </button>
        <button class="ld-btn ld-btn-primary" id="ld-render-btn" data-testid="button-render">
          ${icon("play")}
          <span>Render View</span>
        </button>
        </div>
      </div>
      <div class="ld-controls-sub">
        <span class="ld-mode-info" id="ld-mode-info" data-testid="text-mode-info"></span>
        <div class="ld-sub-selects">
        <select class="ld-select" id="ld-lang" title="Editor language" data-testid="select-language"></select>
        <select class="ld-select" id="ld-mode" title="Parse mode" data-testid="select-mode">
          <option value="auto">Auto</option>
          <option value="bilingual">Bilingual (- / +)</option>
          <option value="patch">Patch / diff</option>
          <option value="compare">Compare (A === B)</option>
        </select>
        </div>
      </div>
    </header>
    <div class="ld-search-bar" id="ld-search-bar">
      ${icon("search", 14, "ld-search-icon")}
      <input type="text" id="ld-search-input" class="ld-search-input" placeholder="Search text..." data-testid="input-search">
      <span class="ld-search-count" id="ld-search-count"></span>
      <button class="ld-search-nav-btn" id="ld-search-prev" title="Previous match" data-testid="button-search-prev">${icon("chevronUp", 14)}</button>
      <button class="ld-search-nav-btn" id="ld-search-next" title="Next match" data-testid="button-search-next">${icon("chevronDown", 14)}</button>
      <div class="ld-search-divider"></div>
      <span class="ld-search-goto-label">Go to line</span>
      <input type="number" min="1" id="ld-goto-input" class="ld-goto-input" placeholder="#" data-testid="input-goto-line">
      <button class="ld-search-nav-btn ld-search-goto-btn" id="ld-goto-btn" data-testid="button-goto-line">Go</button>
      <button class="ld-search-close" id="ld-search-close" title="Close" data-testid="button-close-search">${icon("x", 14)}</button>
    </div>
    <div class="ld-filebar" id="ld-filebar">
      <button class="ld-search-nav-btn" id="ld-files-toggle" title="File list (f)" data-testid="button-files">${withIcon("list", "Files")}</button>
      <button class="ld-search-nav-btn" id="ld-prev-hunk" title="Previous hunk (k)" data-testid="button-prev-hunk">${icon("chevronUp", 14)}</button>
      <button class="ld-search-nav-btn" id="ld-next-hunk" title="Next hunk (j)" data-testid="button-next-hunk">${icon("chevronDown", 14)}</button>
      <span class="ld-fs ld-fs-M" id="ld-fb-status"></span>
      <span class="ld-fb-path" id="ld-fb-path" data-testid="text-current-file"></span>
      <span class="ld-fb-stats" id="ld-fb-stats"></span>
      <button class="ld-search-nav-btn" id="ld-fb-collapse" title="Collapse / expand file (c)" data-testid="button-collapse-file">${withIcon("fold", "Collapse")}</button>
    </div>
    <div class="ld-mergebar" id="ld-mergebar">
      <span class="ld-merge-info" id="ld-merge-info" data-testid="text-merge-info"></span>
      <button class="ld-btn" id="ld-take-all-b" data-testid="button-take-all-b">Take all B</button>
      <button class="ld-btn" id="ld-keep-all-a" data-testid="button-keep-all-a">Keep all A</button>
      <button class="ld-btn" id="ld-merge-reset" data-testid="button-merge-reset">${withIcon("reset", "Reset")}</button>
      <span class="ld-merge-spacer"></span>
      <button class="ld-btn" id="ld-merge-copy" data-testid="button-merge-copy">${withIcon("copy", "Copy merged")}</button>
      <button class="ld-btn ld-btn-primary" id="ld-merge-apply" data-testid="button-merge-apply">${withIcon("merge", "Apply merge")}</button>
    </div>
    <aside class="ld-files-panel" id="ld-files-panel">
      <div class="ld-files-head">
        <input type="text" id="ld-files-filter" class="ld-search-input" placeholder="Filter files..." data-testid="input-file-filter">
        <button class="ld-search-nav-btn" id="ld-collapse-all" data-testid="button-collapse-all">${withIcon("fold", "Collapse all")}</button>
        <button class="ld-search-nav-btn" id="ld-expand-all" data-testid="button-expand-all">${withIcon("unfold", "Expand all")}</button>
        <button class="ld-search-nav-btn ld-files-close" id="ld-files-close" title="Close (Esc)" data-testid="button-close-files">${icon("x", 14)}</button>
      </div>
      <div class="ld-files-list" id="ld-files-list"></div>
    </aside>
    <main class="ld-main" id="ld-drop-zone">
      <div class="ld-left-col" id="ld-left-panel">
      <div class="ld-pane-title">Text A &mdash; original</div>
      <div class="ld-editor-container" id="ld-editor-box">
        <div class="ld-cm" id="ld-cm-a" data-testid="input-editor"></div>
      </div>
      <div class="ld-b-pane" id="ld-b-pane">
        <div class="ld-pane-title">Text B &mdash; modified</div>
        <div class="ld-cm" id="ld-cm-b" data-testid="input-editor-b"></div>
      </div>
      </div>
      <div class="ld-viewer-scroll" id="ld-viewer-scroll" data-testid="viewer-diff">
        <div class="ld-viewer-empty" id="ld-viewer-empty">Paste text and click Render View to see the diff.</div>
        <div class="ld-viewer-spacer" id="ld-viewer-spacer"></div>
      </div>
    </main>

    <div id="ld-usage-modal" class="ld-modal-overlay">
      <div class="ld-modal-card">
        <div class="ld-modal-close-wrapper">
          <button class="ld-modal-close-btn" id="ld-usage-close" data-testid="button-close-usage">
            ${icon("x", 18)}
          </button>
        </div>
        <div class="ld-modal-header">
          <h3>Langdiff - Usage & Formatting Guide</h3>
        </div>
        <div class="ld-modal-body">
          <p class="ld-modal-intro">The rendering engine follows one strict rule: <strong>every row beginning with <code>+ </code> or <code>- </code> has the prefix symbol AND exactly one following space stripped.</strong> Indentation spaces after that first stripped space are preserved exactly.</p>
          <div class="ld-modal-section-title">SYNTAX RULES</div>
          <table class="ld-modal-table">
            <thead><tr><th>Prefix</th><th>Row Appearance</th><th>Ideal Use Case</th></tr></thead>
            <tbody>
              <tr><td><code>-&nbsp;</code></td><td><span class="ld-badge ld-badge-red">Red Background</span></td><td>Original language / old code</td></tr>
              <tr><td><code>+&nbsp;</code></td><td><span class="ld-badge ld-badge-green">Green Background</span></td><td>Target language / updated code</td></tr>
              <tr><td><code>&nbsp;&nbsp;</code> (2 spaces)</td><td>Standard row</td><td>Context / shared description</td></tr>
            </tbody>
          </table>
          <div class="ld-modal-section-title">FORMATTING EXAMPLE</div>
          <pre>  This is a standard row using 2 leading spaces.
- I am using the Langdiff application in Vietnamese.
+ I am using the Langdiff application in English.</pre>
          <div class="ld-modal-section-title">PATCH / DIFF FILES</div>
          <p class="ld-modal-intro">Load a <code>.patch</code> or <code>.diff</code> file (git or unified format) and Langdiff switches to patch mode automatically. File headers and <code>@@</code> hunks get their own rows, only the single leading <code>+</code> / <code>-</code> / space is stripped (indentation is kept), and line numbers follow the real numbers from each hunk header. Use the mode selector in the toolbar to force Bilingual or Patch.</p>
          <p class="ld-modal-intro">Shortcuts (when focus is not in a text field): <code>j</code>/<code>k</code> next/previous hunk, <code>]</code>/<code>[</code> next/previous file, <code>c</code> fold/unfold current file, <code>f</code> file list. Clicking a file row also folds it.</p>
          <div class="ld-modal-section-title">COMPARE TWO TEXTS</div>
          <p class="ld-modal-intro">Choose <em>Compare</em> in the mode selector: the editor becomes Text A (original) and a second box appears for Text B (modified). Click Render View and Langdiff diffs them line by line (a line containing only <code>===</code> between two texts in Auto mode still works), highlights changed words, and offers a Split (side-by-side) view and optional Syntax colouring from the toolbar.</p>
        </div>
      </div>
    </div>
  `;

  const dropZone = root.querySelector<HTMLElement>("#ld-drop-zone")!;
  const leftPanel = root.querySelector<HTMLElement>("#ld-left-panel")!;
  const viewerScroll = root.querySelector<HTMLElement>("#ld-viewer-scroll")!;
  const viewerSpacer = root.querySelector<HTMLElement>("#ld-viewer-spacer")!;
  const viewerEmpty = root.querySelector<HTMLElement>("#ld-viewer-empty")!;
  const filePicker = root.querySelector<HTMLInputElement>("#ld-file-picker")!;
  const usageBtn = root.querySelector<HTMLButtonElement>("#ld-usage-btn")!;
  const usageModal = root.querySelector<HTMLElement>("#ld-usage-modal")!;
  const usageClose = root.querySelector<HTMLButtonElement>("#ld-usage-close")!;
  const toggleBtn = root.querySelector<HTMLButtonElement>("#ld-toggle-input")!;
  const renderBtn = root.querySelector<HTMLButtonElement>("#ld-render-btn")!;
  const findBtn = root.querySelector<HTMLButtonElement>("#ld-find-btn")!;
  const searchBar = root.querySelector<HTMLElement>("#ld-search-bar")!;
  const searchInput = root.querySelector<HTMLInputElement>("#ld-search-input")!;
  const searchCount = root.querySelector<HTMLElement>("#ld-search-count")!;
  const searchPrevBtn = root.querySelector<HTMLButtonElement>("#ld-search-prev")!;
  const searchNextBtn = root.querySelector<HTMLButtonElement>("#ld-search-next")!;
  const gotoInput = root.querySelector<HTMLInputElement>("#ld-goto-input")!;
  const gotoBtn = root.querySelector<HTMLButtonElement>("#ld-goto-btn")!;
  const searchCloseBtn = root.querySelector<HTMLButtonElement>("#ld-search-close")!;

  // ---------- Editors (CodeMirror 6) ----------

  const LANG_KEY = "langdiff_lang";
  const THEME_KEY = "langdiff_theme";
  const B_KEY = "langdiff_b";
  const DEFAULT_PLACEHOLDER =
    "Paste your bilingual text here...\n- Vietnamese line\n+ English line\n\n...or load a .patch / .diff file";

  const savedLang = localStorage.getItem(LANG_KEY);
  let editorLang: LangId = LANGUAGES.some((l) => l.id === savedLang) ? (savedLang as LangId) : "text";
  let editorDark = localStorage.getItem(THEME_KEY) === "dark";

  let saveTimer: number | undefined;
  const editorA = createEditor(root.querySelector<HTMLElement>("#ld-cm-a")!, {
    doc: localStorage.getItem(STORAGE_KEY) ?? "",
    placeholder: DEFAULT_PLACEHOLDER,
    language: editorLang,
    dark: editorDark,
    onChange: () => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => localStorage.setItem(STORAGE_KEY, editorA.getText()), 400);
    },
  });
  const editorB = createEditor(root.querySelector<HTMLElement>("#ld-cm-b")!, {
    doc: localStorage.getItem(B_KEY) ?? "",
    placeholder: "Paste text B (modified) here...",
    language: editorLang,
    dark: editorDark,
    onChange: () => localStorage.setItem(B_KEY, editorB.getText()),
  });

  const langSel = root.querySelector<HTMLSelectElement>("#ld-lang")!;
  for (const l of LANGUAGES) {
    const o = document.createElement("option");
    o.value = l.id;
    o.textContent = l.label;
    langSel.appendChild(o);
  }
  langSel.value = editorLang;
  langSel.addEventListener("change", () => {
    editorLang = langSel.value as LangId;
    localStorage.setItem(LANG_KEY, editorLang);
    editorA.setLanguage(editorLang);
    editorB.setLanguage(editorLang);
  });

  root.classList.toggle("ld-dark", editorDark);
  const themeBtn = root.querySelector<HTMLButtonElement>("#ld-theme-btn")!;
  const syncThemeBtn = () => {
    themeBtn.innerHTML = editorDark ? withIcon("moon", "Theme: Dark") : withIcon("sun", "Theme: Light");
  };
  syncThemeBtn();
  themeBtn.addEventListener("click", () => {
    editorDark = !editorDark;
    localStorage.setItem(THEME_KEY, editorDark ? "dark" : "light");
    editorA.setDark(editorDark);
    editorB.setDark(editorDark);
    root.classList.toggle("ld-dark", editorDark);
    syncThemeBtn();
  });

  // ---------- Diff parsing ----------

  const modeSelect = root.querySelector<HTMLSelectElement>("#ld-mode")!;
  const modeInfo = root.querySelector<HTMLElement>("#ld-mode-info")!;
  let fileInfos: FileInfo[] = [];
  let viewKind: "bilingual" | "patch" | "compare" = "bilingual";
  let compareRows: DiffLine[] = [];
  let chunkTake = new Uint8Array(0); // per change: 0 undecided, 1 keep A, 2 take B
  let compareUsedSep = false;

  function compareDisplay(): DiffLine[] {
    const rows = withHeaders(compareRows);
    return compareView === "split" ? toSplit(rows) : rows;
  }
  let compareView: "unified" | "split" = localStorage.getItem("langdiff_cmpview") === "split" ? "split" : "unified";
  let syntaxOn = localStorage.getItem("langdiff_syntax") === "1";

  function parseDiff(lines: string[]): DiffLine[] {
    const mode = modeSelect.value as ParseMode;
    const asPatch = mode === "patch" || (mode === "auto" && looksLikePatch(lines));
    if (asPatch) {
      const r = parsePatch(lines);
      fileInfos = r.files;
      viewKind = "patch";
      modeInfo.textContent = `Patch \u00b7 ${r.stats.files} files \u00b7 ${r.stats.hunks} hunks \u00b7 +${r.stats.added} \u2212${r.stats.removed}`;
      return r.lines;
    }
    fileInfos = [];
    viewKind = "bilingual";
    const sep = lines.findIndex((l) => SEP_RE.test(l));
    if (mode === "compare" || (mode === "auto" && sep >= 0)) {
      viewKind = "compare";
      const clean = (x: string[]) => {
        const r = x.map((l) => l.replace(/\r$/, ""));
        while (r.length && r[r.length - 1].trim() === "") r.pop();
        return r;
      };
      const bText = editorB.getText();
      const useSep = sep >= 0 && bText.trim() === "";
      const A = clean(useSep ? lines.slice(0, sep) : lines);
      const B = clean(useSep ? lines.slice(sep + 1) : bText.split("\n"));
      compareRows = buildCompare(A, B);
      compareUsedSep = useSep;
      chunkTake = new Uint8Array(compareRows.reduce((m, r) => (r.chunk === undefined ? m : Math.max(m, r.chunk + 1)), 0));
      modeInfo.textContent = B.length === 0
        ? "Compare: text B is empty"
        : `Compare \u00b7 A ${A.length} lines \u00b7 B ${B.length} lines`;
      return compareDisplay();
    }
    modeInfo.textContent = "Bilingual";
    return parseBilingual(lines);
  }

  // ---------- Diff viewer virtualization ----------

  let diffLines: DiffLine[] = [];
  let rowHeights: Float64Array = new Float64Array(0);
  let rowTops: Float64Array = new Float64Array(0);
  let numColWidth = 75;
  const rowPool = new Map<number, HTMLDivElement>();
  const rowFreeList: HTMLDivElement[] = [];
  let viewerScheduled = false;
  let mountedStart = -1;
  let mountedEnd = -2;
  let pendingHighlightRow = -1;
  const collapsed = new Set<number>();

  function findStartIndex(scrollTop: number): number {
    let lo = 0;
    let hi = rowTops.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (rowTops[mid] <= scrollTop) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function createRow(): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "ld-diff-line";
    row.innerHTML = `
      <div class="ld-line-numbers">
        <div class="ld-num-old"></div>
        <div class="ld-num-new"></div>
      </div>
      <div class="ld-line-separator"></div>
      <div class="ld-line-content"></div>
      <div class="ld-split-wrap">
        <div class="ld-half ld-half-l"><span class="ld-hn"></span><span class="ld-hc"></span></div>
        <div class="ld-half ld-half-r"><span class="ld-hn"></span><span class="ld-hc"></span></div>
      </div>
    `;
    return row;
  }

  function rejected(d: DiffLine): boolean {
    if (d.chunk === undefined) return false;
    const st = chunkTake[d.chunk];
    return (d.type === "minus" && st === 2) || (d.type === "plus" && st === 1);
  }

  function fillChunkRow(el: HTMLElement, d: DiffLine) {
    const st = chunkTake[d.chunk as number];
    const label = document.createElement("span");
    label.className = "ld-ch-label";
    label.textContent = d.content;
    const btn = (text: string, side: number, on: string) => {
      const b = document.createElement("button");
      b.className = "ld-ch-btn" + (st === side ? ` ${on}` : "");
      b.textContent = text;
      b.dataset.chunk = String(d.chunk);
      b.dataset.side = String(side);
      return b;
    };
    el.replaceChildren(label, btn("Keep A", 1, "on-a"), btn("Take B", 2, "on-b"));
  }

  function refreshMounted() {
    for (const [idx, row] of rowPool) fillRow(row, idx);
  }

  function statsNode(fi: FileInfo | undefined, cls: string): HTMLElement {
    const box = document.createElement("span");
    box.className = cls;
    if (fi) {
      const a = document.createElement("b");
      a.className = "ld-add";
      a.textContent = `+${fi.added}`;
      const r = document.createElement("b");
      r.className = "ld-del";
      r.textContent = `\u2212${fi.removed}`;
      box.append(a, r);
    }
    return box;
  }

  function fillFileRow(el: HTMLElement, d: DiffLine) {
    const fi = fileInfos[d.file as number];
    const mk = (cls: string, text: string) => {
      const sp = document.createElement("span");
      sp.className = cls;
      sp.textContent = text;
      return sp;
    };
    const chev = mk("ld-fr-chev", "");
    chev.innerHTML = icon(collapsed.has(d.file as number) ? "chevronRight" : "chevronDown", 13);
    el.replaceChildren(
      chev,
      mk(`ld-fs ld-fs-${fi?.status ?? "M"}`, fi?.status ?? "M"),
      mk("ld-fr-name", d.content),
      statsNode(fi, "ld-fr-stats"),
    );
  }

  function renderContent(el: HTMLElement, text: string, parts?: Part[]) {
    const sc = syntaxOn && viewKind === "compare" ? syntaxClasses(text) : null;
    if (!parts && !sc) { el.textContent = text; return; }
    const ch = new Uint8Array(text.length);
    if (parts) {
      let p = 0;
      for (const [t, f] of parts) { if (f) ch.fill(1, p, p + t.length); p += t.length; }
    }
    const frag = document.createDocumentFragment();
    let start = 0;
    for (let i = 1; i <= text.length; i++) {
      if (i === text.length || ch[i] !== ch[start] || (sc && sc[i] !== sc[start])) {
        const sp = document.createElement("span");
        sp.className = (sc && sc[start] ? `ld-tk${sc[start]}` : "") + (ch[start] ? " ld-wd" : "");
        sp.textContent = text.slice(start, i);
        frag.appendChild(sp);
        start = i;
      }
    }
    el.replaceChildren(frag);
  }

  function fillHalf(el: HTMLElement, c: DiffLine | undefined, side: "l" | "r") {
    el.className = `ld-half ld-half-${side}` + (c ? (c.type !== "normal" ? ` ld-${c.type}` : "") : " ld-empty");
    el.children[0].textContent = c ? String(side === "l" ? c.oldNum : c.newNum) : "";
    if (c && rejected(c)) el.classList.add("ld-rejected");
    renderContent(el.children[1] as HTMLElement, c ? c.content : "", c?.parts);
  }

  function fillRow(row: HTMLDivElement, idx: number) {
    const d = diffLines[idx];
    row.className = `ld-diff-line ld-${d.type}` + (idx === pendingHighlightRow ? " ld-row-flash" : "");
    row.style.top = `${rowTops[idx]}px`;
    row.style.height = `${rowHeights[idx]}px`;
    if (idx === navRow) row.classList.add("ld-nav-active");
    if (rejected(d)) row.classList.add("ld-rejected");
    if (d.type === "split") {
      const wrap = row.children[3];
      fillHalf(wrap.children[0] as HTMLElement, d.left, "l");
      fillHalf(wrap.children[1] as HTMLElement, d.right, "r");
      return;
    }
    (row.querySelector(".ld-num-old") as HTMLElement).textContent =
      d.oldNum === "" ? "" : String(d.oldNum);
    (row.querySelector(".ld-num-new") as HTMLElement).textContent =
      d.newNum === "" ? "" : String(d.newNum);
    (row.querySelector(".ld-line-content") as HTMLElement).textContent =
      d.type === "file" && d.file !== undefined && d.file >= 0
        ? (collapsed.has(d.file) ? "\u25b8 " : "\u25be ") + d.content
        : d.content;
    row.dataset.idx = String(idx);
    if (d.type === "file" && d.file !== undefined && d.file >= 0) {
      fillFileRow(row.querySelector(".ld-line-content") as HTMLElement, d);
    }
    if (d.type === "chunk") {
      fillChunkRow(row.querySelector(".ld-line-content") as HTMLElement, d);
    } else if (d.parts || (syntaxOn && viewKind === "compare" && d.type !== "file")) {
      renderContent(row.querySelector(".ld-line-content") as HTMLElement, d.content, d.parts);
    }
  }

  function renderViewerWindow() {
    viewerScheduled = false;
    if (diffLines.length === 0) return;

    const scrollTop = viewerScroll.scrollTop;
    const clientHeight = viewerScroll.clientHeight;
    const wantStart = findStartIndex(Math.max(0, scrollTop - VIEWER_BUFFER_PX));
    const wantEndScroll = scrollTop + clientHeight + VIEWER_BUFFER_PX;
    let wantEnd = findStartIndex(wantEndScroll);
    if (wantEnd < diffLines.length - 1 && rowTops[wantEnd] < wantEndScroll)
      wantEnd++;
    wantEnd = Math.min(diffLines.length - 1, wantEnd);

    if (wantStart === mountedStart && wantEnd === mountedEnd) return;

    for (const [idx, el] of rowPool) {
      if (idx < wantStart || idx > wantEnd) {
        rowPool.delete(idx);
        el.remove();
        rowFreeList.push(el);
      }
    }

    const frag = document.createDocumentFragment();
    for (let i = wantStart; i <= wantEnd; i++) {
      if (rowPool.has(i) || rowHeights[i] === 0) continue;
      const row = rowFreeList.pop() ?? createRow();
      fillRow(row, i);
      rowPool.set(i, row);
      frag.appendChild(row);
    }
    viewerSpacer.appendChild(frag);
    mountedStart = wantStart;
    mountedEnd = wantEnd;

    // Heights are first estimated from character counts; the browser wraps at word
    // boundaries, so some rows need more room. Measure what is mounted and fix it.
    if (fixDepth < 4) {
      fixDepth++;
      if (fixRowHeights()) {
        mountedStart = -1;
        mountedEnd = -2;
        renderViewerWindow();
      }
      fixDepth--;
    }
  }

  let fixDepth = 0;

  function fixRowHeights(): boolean {
    let changed = false;
    for (const [idx, row] of rowPool) {
      const d = diffLines[idx];
      if (d.type === "file" || d.type === "chunk") continue;
      let need = 0;
      if (d.type === "split") {
        for (const half of Array.from(row.children[3].children)) {
          need = Math.max(need, (half.children[1] as HTMLElement).scrollHeight);
        }
      } else {
        need = (row.querySelector(".ld-line-content") as HTMLElement).scrollHeight;
      }
      const want = Math.ceil((need - 1) / LINE_HEIGHT_PX) * LINE_HEIGHT_PX;
      if (want > rowHeights[idx] + 1) {
        rowHeights[idx] = want;
        changed = true;
      }
    }
    if (!changed) return false;

    // Keep the first visible row where it is while the rows below it move.
    const st = viewerScroll.scrollTop;
    const anchor = findStartIndex(st);
    const before = rowTops[anchor] - st;
    let acc = 0;
    for (let i = 0; i < diffLines.length; i++) {
      rowTops[i] = acc;
      acc += rowHeights[i];
    }
    rowTops[diffLines.length] = acc;
    viewerSpacer.style.height = `${acc}px`;
    for (const [idx, row] of rowPool) {
      row.style.top = `${rowTops[idx]}px`;
      row.style.height = `${rowHeights[idx]}px`;
    }
    viewerScroll.scrollTop = rowTops[anchor] - before;
    return true;
  }

  function scheduleViewerUpdate() {
    if (viewerScheduled) return;
    viewerScheduled = true;
    requestAnimationFrame(renderViewerWindow);
  }

  viewerScroll.addEventListener("scroll", scheduleViewerUpdate);
  let viewerResizeScheduled = false;
  window.addEventListener("resize", () => {
    if (diffLines.length === 0 || viewerResizeScheduled) return;
    viewerResizeScheduled = true;
    requestAnimationFrame(() => {
      viewerResizeScheduled = false;
      recomputeLayoutAndRerender();
    });
  });

  let cachedCharWidth = 0;
  let cachedNumCharWidth = 0;

  function measureContentWidth(): number {
    const probe = createRow();
    probe.style.visibility = "hidden";
    probe.style.position = "absolute";
    probe.style.top = "-9999px";
    (probe.querySelector(".ld-line-numbers") as HTMLElement).style.width =
      `${numColWidth}px`;
    (probe.querySelector(".ld-line-numbers") as HTMLElement).style.minWidth =
      `${numColWidth}px`;
    viewerSpacer.appendChild(probe);
    const width = (probe.querySelector(".ld-line-content") as HTMLElement)
      .clientWidth;
    probe.remove();
    return Math.max(1, width);
  }

  function recomputeLayoutAndRerender() {
    if (!cachedCharWidth) cachedCharWidth = measureCharWidth();
    if (!cachedNumCharWidth) cachedNumCharWidth = measureNumCharWidth();

    const maxNum = diffLines.reduce((m, d) => {
      const o = d.oldNum === "" ? 0 : d.oldNum;
      const n = d.newNum === "" ? 0 : d.newNum;
      return Math.max(m, o, n);
    }, 1);
    const digits = String(maxNum).length;
    numColWidth = Math.max(75, Math.ceil(digits * cachedNumCharWidth * 2) + 24);
    document.documentElement.style.setProperty(
      "--ld-num-col-width",
      `${numColWidth}px`,
    );

    const contentWidth = measureContentWidth();
    const charsPerLine = Math.max(
      1,
      Math.floor(contentWidth / cachedCharWidth),
    );

    const splitCpl = Math.max(1, Math.floor(((viewerSpacer.clientWidth || viewerScroll.clientWidth) / 2 - 76) / cachedCharWidth));
    rowHeights = new Float64Array(diffLines.length);
    rowTops = new Float64Array(diffLines.length + 1);
    let acc = 0;
    for (let i = 0; i < diffLines.length; i++) {
      const dl = diffLines[i];
      const isSplit = dl.type === "split";
      const len = isSplit ? Math.max(dl.left?.content.length ?? 0, dl.right?.content.length ?? 0) : dl.content.length;
      const visualLines = len === 0 ? 1 : Math.ceil(len / (isSplit ? splitCpl : charsPerLine));
      const f = diffLines[i].file;
      const hidden = f !== undefined && f >= 0 && ((collapsed.has(f) && dl.type !== "file") || dl.type === "meta");
      const h = hidden ? 0 : dl.type === "file" ? 34 : dl.type === "chunk" ? 32 : visualLines * LINE_HEIGHT_PX;
      rowHeights[i] = h;
      rowTops[i] = acc;
      acc += h;
    }
    rowTops[diffLines.length] = acc;
    viewerSpacer.style.height = `${acc}px`;

    // Force a fresh mount of the visible window.
    for (const el of rowPool.values()) {
      el.remove();
      rowFreeList.push(el);
    }
    rowPool.clear();
    mountedStart = -1;
    mountedEnd = -2;
    renderViewerWindow();
  }

  function processText() {
    // Always render what the inputs hold now, including nothing: an empty input must clear the view.
    const rawText = editorA.getText();
    localStorage.setItem(STORAGE_KEY, rawText);
    diffLines = parseDiff(rawText.split("\n"));
    modeInfo.title = modeInfo.textContent ?? ""; // full text on hover when the pill is truncated
    const nothing = !rawText.trim() && !(viewKind === "compare" && editorB.getText().trim());
    if (nothing) diffLines = [];
    viewerEmpty.style.display = diffLines.length === 0 ? "" : "none";
    collapsed.clear();
    buildFileList();
    syncCompareUi();
    recomputeLayoutAndRerender();
    updateFilebar(true);
  }

  // ---------- Compare mode toolbar ----------

  const splitBtn = root.querySelector<HTMLButtonElement>("#ld-split-btn")!;
  const syntaxBtn = root.querySelector<HTMLButtonElement>("#ld-syntax-btn")!;
  function syncCompareButtons() {
    splitBtn.innerHTML = compareView === "split" ? withIcon("rows", "Unified view") : withIcon("columns", "Split view");
    syntaxBtn.innerHTML = withIcon("code", syntaxOn ? "Syntax: on" : "Syntax: off");
  }
  function syncCompareUi() {
    const on = modeSelect.value === "compare" || viewKind === "compare";
    root.classList.toggle("ld-compare", on);
    editorA.setPlaceholder(on ? "Paste text A (original) here..." : DEFAULT_PLACEHOLDER);
    updateMergeBar();
  }
  syncCompareButtons();
  splitBtn.addEventListener("click", () => {
    compareView = compareView === "split" ? "unified" : "split";
    localStorage.setItem("langdiff_cmpview", compareView);
    syncCompareButtons();
    if (viewKind === "compare") {
      diffLines = compareDisplay();
      recomputeLayoutAndRerender();
    }
  });
  syntaxBtn.addEventListener("click", () => {
    syntaxOn = !syntaxOn;
    localStorage.setItem("langdiff_syntax", syntaxOn ? "1" : "0");
    syncCompareButtons();
    if (diffLines.length > 0) recomputeLayoutAndRerender();
  });

  // ---------- In-app dialog (replaces the browser's alert / confirm) ----------

  interface DialogOptions {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string | null; // null = information only (single OK button)
  }

  function showDialog(opts: DialogOptions): Promise<boolean> {
    return new Promise((resolve) => {
      const prevFocus = document.activeElement as HTMLElement | null;
      const overlay = document.createElement("div");
      overlay.className = "ld-dialog-overlay";
      const card = document.createElement("div");
      card.className = "ld-dialog";
      card.setAttribute("role", "dialog");
      card.setAttribute("aria-modal", "true");
      const title = document.createElement("div");
      title.className = "ld-dialog-title";
      title.textContent = opts.title;
      const msg = document.createElement("div");
      msg.className = "ld-dialog-message";
      msg.textContent = opts.message;
      const actions = document.createElement("div");
      actions.className = "ld-dialog-actions";

      const buttons: HTMLButtonElement[] = [];
      const mk = (text: string, cls: string, result: boolean) => {
        const b = document.createElement("button");
        b.className = cls;
        b.textContent = text;
        b.addEventListener("click", () => close(result));
        buttons.push(b);
        actions.appendChild(b);
        return b;
      };

      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close(false);
        } else if (e.key === "Tab") {
          e.preventDefault();
          const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[(i + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
        }
      };
      function close(result: boolean) {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        prevFocus?.focus();
        resolve(result);
      }

      if (opts.cancelText !== null) mk(opts.cancelText ?? "Cancel", "ld-btn", false);
      const ok = mk(opts.confirmText ?? "OK", "ld-btn ld-btn-primary", true);
      card.append(title, msg, actions);
      overlay.appendChild(card);
      overlay.addEventListener("mousedown", (e) => {
        if (e.target === overlay) close(false);
      });
      document.addEventListener("keydown", onKey, true);
      root.appendChild(overlay);
      ok.focus();
    });
  }

  // ---------- Merge (Compare mode) ----------

  const mergeInfo = root.querySelector<HTMLElement>("#ld-merge-info")!;
  const copyBtn = root.querySelector<HTMLButtonElement>("#ld-merge-copy")!;
  const applyBtn = root.querySelector<HTMLButtonElement>("#ld-merge-apply")!;

  function updateMergeBar() {
    let a = 0;
    let b = 0;
    for (const v of chunkTake) {
      if (v === 1) a++;
      else if (v === 2) b++;
    }
    const total = chunkTake.length;
    mergeInfo.textContent = viewKind !== "compare"
      ? "Render View to compare"
      : total === 0
        ? "No differences"
        : `${total} changes \u00b7 ${b} from B \u00b7 ${a} keep A \u00b7 ${total - a - b} undecided (copied as A)`;
    copyBtn.disabled = viewKind !== "compare";
    applyBtn.disabled = a + b === 0;
  }

  // Merged text = A with every change set to "Take B" replaced by B's version.
  function mergedLines(): string[] {
    const out: string[] = [];
    for (const r of compareRows) {
      if (r.chunk === undefined) out.push(r.content);
      else if (r.type === "minus" ? chunkTake[r.chunk] !== 2 : chunkTake[r.chunk] === 2) out.push(r.content);
    }
    return out;
  }

  function setAllChunks(v: number) {
    chunkTake.fill(v);
    refreshMounted();
    updateMergeBar();
  }

  viewerSpacer.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".ld-ch-btn");
    if (!b) return;
    const c = parseInt(b.dataset.chunk ?? "", 10);
    const side = parseInt(b.dataset.side ?? "", 10);
    chunkTake[c] = chunkTake[c] === side ? 0 : side;
    refreshMounted();
    updateMergeBar();
  });

  root.querySelector("#ld-take-all-b")!.addEventListener("click", () => setAllChunks(2));
  root.querySelector("#ld-keep-all-a")!.addEventListener("click", () => setAllChunks(1));
  root.querySelector("#ld-merge-reset")!.addEventListener("click", () => setAllChunks(0));

  copyBtn.addEventListener("click", async () => {
    const text = mergedLines().join("\n");
    let copied = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      } finally {
        ta.remove();
      }
    }
    copyBtn.innerHTML = copied ? withIcon("check", "Copied") : withIcon("x", "Copy failed");
    setTimeout(() => { copyBtn.innerHTML = withIcon("copy", "Copy merged"); }, 1200);
  });

  // Apply: decided changes become identical in both inputs; undecided ones stay different.
  applyBtn.addEventListener("click", async () => {
    const decided = chunkTake.reduce((n, v) => n + (v ? 1 : 0), 0);
    if (!decided) return;
    const ok = await showDialog({
      title: "Apply merge?",
      message: `${decided} change${decided === 1 ? "" : "s"} will be written to both inputs, so Text A and Text B become identical at those places. Changes you have not decided on stay different.`,
      confirmText: "Apply merge",
    });
    if (!ok) return;
    const A: string[] = [];
    const B: string[] = [];
    for (const r of compareRows) {
      if (r.chunk === undefined) { A.push(r.content); B.push(r.content); continue; }
      const st = chunkTake[r.chunk];
      if (st === 0) (r.type === "minus" ? A : B).push(r.content);
      else if (r.type === "minus") { if (st === 1) { A.push(r.content); B.push(r.content); } }
      else if (st === 2) { A.push(r.content); B.push(r.content); }
    }
    if (compareUsedSep) {
      editorA.setText(A.join("\n") + "\n===\n" + B.join("\n"));
    } else {
      editorA.setText(A.join("\n"));
      editorB.setText(B.join("\n"));
    }
    processText();
  });

  // ---------- Patch navigation: file bar, file list, hunks, collapse ----------

  const filebar = root.querySelector<HTMLElement>("#ld-filebar")!;
  const fbStatus = root.querySelector<HTMLElement>("#ld-fb-status")!;
  const fbPath = root.querySelector<HTMLElement>("#ld-fb-path")!;
  const fbStats = root.querySelector<HTMLElement>("#ld-fb-stats")!;
  const fbCollapse = root.querySelector<HTMLButtonElement>("#ld-fb-collapse")!;
  const filesPanel = root.querySelector<HTMLElement>("#ld-files-panel")!;
  const filesList = root.querySelector<HTMLElement>("#ld-files-list")!;
  const filesFilter = root.querySelector<HTMLInputElement>("#ld-files-filter")!;
  let fileItems: HTMLButtonElement[] = [];
  let shownFile = -2;
  let filebarScheduled = false;
  let navRow = -1; // row last stepped to with the arrows / file list
  let navScrollTop = 0; // scrollTop right after that jump

  function buildFileList() {
    filebar.style.display = fileInfos.length > 0 ? "flex" : "none";
    if (fileInfos.length === 0) filesPanel.classList.remove("ld-files-open");
    filesFilter.value = "";
    navRow = -1;
    const frag = document.createDocumentFragment();
    fileItems = fileInfos.map((fi, f) => {
      const b = document.createElement("button");
      b.className = "ld-file-item";
      b.dataset.f = String(f);
      b.title = fi.name;
      const st = document.createElement("span");
      st.className = `ld-fs ld-fs-${fi.status}`;
      st.textContent = fi.status;
      const nm = document.createElement("span");
      nm.className = "ld-fname";
      nm.textContent = fi.name;
      const ct = statsNode(fi, "ld-fb-stats");
      b.append(st, nm, ct);
      frag.appendChild(b);
      return b;
    });
    filesList.replaceChildren(frag);
    shownFile = -2;
  }

  function markCollapsed(f: number) {
    fileItems[f]?.classList.toggle("ld-file-collapsed", collapsed.has(f));
  }

  function navValid(): boolean {
    return (
      navRow >= 0 && navRow < diffLines.length && rowHeights[navRow] > 0 &&
      rowTops[navRow] >= viewerScroll.scrollTop - 1 &&
      rowTops[navRow] < viewerScroll.scrollTop + viewerScroll.clientHeight
    );
  }

  function setNavRow(i: number) {
    navScrollTop = viewerScroll.scrollTop;
    rowPool.get(navRow)?.classList.remove("ld-nav-active");
    navRow = i;
    rowPool.get(i)?.classList.add("ld-nav-active");
    updateFilebar(true);
  }

  function currentFile(): number {
    if (diffLines.length === 0) return -1;
    // Follow the highlighted row until the user scrolls; after that follow the viewport.
    if (navValid() && Math.abs(viewerScroll.scrollTop - navScrollTop) <= 1) return diffLines[navRow].file ?? -1;
    return diffLines[findStartIndex(viewerScroll.scrollTop)]?.file ?? -1;
  }

  function updateFilebar(force = false) {
    filebarScheduled = false;
    if (fileInfos.length === 0) return;
    const f = currentFile();
    if (f === shownFile && !force) return;
    if (shownFile >= 0) fileItems[shownFile]?.classList.remove("ld-file-active");
    shownFile = f;
    const fi = fileInfos[f];
    fbStatus.textContent = fi ? fi.status : "";
    fbStatus.className = `ld-fs ld-fs-${fi ? fi.status : "M"}`;
    fbStatus.style.visibility = fi ? "visible" : "hidden";
    fbPath.textContent = fi ? fi.name : "(patch header)";
    fbStats.replaceChildren(...Array.from(statsNode(fi, "").childNodes));
    fbCollapse.innerHTML = fi && collapsed.has(f) ? withIcon("unfold", "Expand") : withIcon("fold", "Collapse");
    if (fi) {
      const el = fileItems[f];
      el.classList.add("ld-file-active");
      if (filesPanel.classList.contains("ld-files-open")) el.scrollIntoView({ block: "nearest" });
    }
  }

  viewerScroll.addEventListener("scroll", () => {
    if (filebarScheduled) return;
    filebarScheduled = true;
    requestAnimationFrame(() => updateFilebar());
  });

  function toggleFile(f: number) {
    const fr = fileInfos[f]?.firstRow;
    if (fr === undefined) return;
    const off = rowTops[fr] - viewerScroll.scrollTop;
    if (collapsed.has(f)) collapsed.delete(f);
    else collapsed.add(f);
    markCollapsed(f);
    recomputeLayoutAndRerender();
    viewerScroll.scrollTop = rowTops[fr] - off;
    setNavRow(fr);
  }

  function setAllCollapsed(on: boolean) {
    const f = currentFile();
    if (on) fileInfos.forEach((_, i) => collapsed.add(i));
    else collapsed.clear();
    fileItems.forEach((_, i) => markCollapsed(i));
    recomputeLayoutAndRerender();
    viewerScroll.scrollTop = f >= 0 ? rowTops[fileInfos[f].firstRow] : 0;
    updateFilebar(true);
  }

  function stepTo(dir: 1 | -1, isStop: (i: number) => boolean) {
    const st = viewerScroll.scrollTop;
    let from: number;
    let lim: number;
    if (navValid() && Math.abs(st - navScrollTop) <= 1) {
      from = lim = navRow;
    } else {
      from = findStartIndex(st);
      lim = rowTops[from] < st - 1 ? from + 1 : from;
    }
    let target = -1;
    if (dir === 1) {
      for (let i = from + 1; i < diffLines.length; i++) {
        if (rowHeights[i] > 0 && isStop(i)) { target = i; break; }
      }
    } else {
      for (let i = lim - 1; i >= 0; i--) {
        if (rowHeights[i] > 0 && isStop(i)) { target = i; break; }
      }
    }
    if (target < 0) return;
    viewerScroll.scrollTop = rowTops[target];
    setNavRow(target);
  }

  // A stop is a hunk, or the header of a collapsed file (its hunks are hidden).
  function stepHunk(dir: 1 | -1) {
    stepTo(dir, (i) => diffLines[i].type === "hunk" || (diffLines[i].type === "file" && collapsed.has(diffLines[i].file as number)));
  }

  function stepFile(dir: 1 | -1) {
    stepTo(dir, (i) => diffLines[i].type === "file");
  }

  function toggleFilesPanel() {
    const open = filesPanel.classList.toggle("ld-files-open");
    if (open) {
      filesFilter.focus();
      fileItems[shownFile]?.scrollIntoView({ block: "nearest" });
    }
  }

  root.querySelector("#ld-files-toggle")!.addEventListener("click", toggleFilesPanel);
  root.querySelector("#ld-files-close")!.addEventListener("click", () => filesPanel.classList.remove("ld-files-open"));
  root.querySelector("#ld-prev-hunk")!.addEventListener("click", () => stepHunk(-1));
  root.querySelector("#ld-next-hunk")!.addEventListener("click", () => stepHunk(1));
  root.querySelector("#ld-collapse-all")!.addEventListener("click", () => setAllCollapsed(true));
  root.querySelector("#ld-expand-all")!.addEventListener("click", () => setAllCollapsed(false));
  fbCollapse.addEventListener("click", () => {
    const f = currentFile();
    if (f >= 0) toggleFile(f);
  });

  filesList.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".ld-file-item");
    const f = item ? parseInt(item.dataset.f ?? "", 10) : NaN;
    if (isNaN(f)) return;
    if (collapsed.has(f)) {
      collapsed.delete(f);
      markCollapsed(f);
      recomputeLayoutAndRerender();
    }
    viewerScroll.scrollTop = rowTops[fileInfos[f].firstRow];
    setNavRow(fileInfos[f].firstRow);
  });

  filesFilter.addEventListener("input", () => {
    const q = filesFilter.value.trim().toLowerCase();
    fileInfos.forEach((fi, f) => {
      fileItems[f].style.display = !q || fi.name.toLowerCase().includes(q) ? "" : "none";
    });
  });
  filesFilter.addEventListener("keydown", (e) => {
    if (e.key === "Escape") filesPanel.classList.remove("ld-files-open");
  });

  // Click a file row in the viewer to fold / unfold that file.
  viewerSpacer.addEventListener("click", (e) => {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".ld-file");
    const f = rowEl?.dataset.idx !== undefined ? diffLines[parseInt(rowEl.dataset.idx, 10)]?.file : undefined;
    if (f !== undefined && f >= 0) toggleFile(f);
  });

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || fileInfos.length === 0) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement).isContentEditable) return;
    switch (e.key) {
      case "j": stepHunk(1); break;
      case "k": stepHunk(-1); break;
      case "]": stepFile(1); break;
      case "[": stepFile(-1); break;
      case "c": { const f = currentFile(); if (f >= 0) toggleFile(f); break; }
      case "f": toggleFilesPanel(); break;
      case "Escape":
        if (!filesPanel.classList.contains("ld-files-open")) return;
        filesPanel.classList.remove("ld-files-open");
        break;
      default: return;
    }
    e.preventDefault();
  });

  // ---------- Search / go-to-line ----------

  let searchMatches: number[] = [];
  let currentMatchIdx = -1;
  let searchDebounceTimer: number | undefined;
  let pendingHighlightTimeout: number | undefined;

  function openSearch() {
    searchBar.classList.add("ld-search-bar-open");
    searchInput.focus();
    searchInput.select();
  }

  function closeSearch() {
    searchBar.classList.remove("ld-search-bar-open");
  }

  function updateSearchCount() {
    if (!searchInput.value.trim()) {
      searchCount.textContent = "";
    } else if (searchMatches.length === 0) {
      searchCount.textContent = "0/0";
    } else {
      searchCount.textContent = `${currentMatchIdx + 1}/${searchMatches.length}`;
    }
  }

  function jumpToLine(lineIndex: number, focusEditor = false) {
    if (lineIndex < 0 || lineIndex >= editorA.view.state.doc.lines) return;
    // Live search must not steal focus from the search box; only "Go to line" focuses the editor.
    editorA.flashLine(lineIndex, focusEditor);

    const lf = diffLines[lineIndex]?.file;
    if (lf !== undefined && lf >= 0 && collapsed.has(lf) && diffLines[lineIndex].type !== "file") {
      collapsed.delete(lf);
      markCollapsed(lf);
      recomputeLayoutAndRerender();
    }
    if (viewKind !== "compare" && diffLines.length > 0 && lineIndex < diffLines.length) {
      const targetTop = Math.max(0, rowTops[lineIndex] - viewerScroll.clientHeight / 2);
      viewerScroll.scrollTop = targetTop;
      pendingHighlightRow = lineIndex;
      window.clearTimeout(pendingHighlightTimeout);
      pendingHighlightTimeout = window.setTimeout(() => {
        pendingHighlightRow = -1;
      }, 1500);
      scheduleViewerUpdate();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = rowPool.get(lineIndex);
          if (el) {
            el.classList.remove("ld-row-flash");
            void el.offsetWidth;
            el.classList.add("ld-row-flash");
          }
        });
      });
    }
  }

  function runSearch() {
    const query = searchInput.value;
    searchMatches = [];
    currentMatchIdx = -1;
    if (query.trim()) {
      const q = query.toLowerCase();
      const doc = editorA.view.state.doc;
      for (let i = 1; i <= doc.lines; i++) {
        if (doc.line(i).text.toLowerCase().includes(q)) searchMatches.push(i - 1);
      }
      if (searchMatches.length > 0) currentMatchIdx = 0;
    }
    updateSearchCount();
    if (currentMatchIdx >= 0) jumpToLine(searchMatches[currentMatchIdx]);
  }

  function gotoNextMatch() {
    if (searchMatches.length === 0) return;
    currentMatchIdx = (currentMatchIdx + 1) % searchMatches.length;
    updateSearchCount();
    jumpToLine(searchMatches[currentMatchIdx]);
  }

  function gotoPrevMatch() {
    if (searchMatches.length === 0) return;
    currentMatchIdx = (currentMatchIdx - 1 + searchMatches.length) % searchMatches.length;
    updateSearchCount();
    jumpToLine(searchMatches[currentMatchIdx]);
  }

  findBtn.addEventListener("click", () => {
    if (searchBar.classList.contains("ld-search-bar-open")) {
      closeSearch();
    } else {
      openSearch();
    }
  });
  searchCloseBtn.addEventListener("click", closeSearch);

  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && !(e.target instanceof Element && e.target.closest(".cm-editor"))) {
      e.preventDefault();
      openSearch();
    } else if (e.key === "Escape" && searchBar.classList.contains("ld-search-bar-open")) {
      closeSearch();
    }
  });

  searchInput.addEventListener("input", () => {
    window.clearTimeout(searchDebounceTimer);
    searchDebounceTimer = window.setTimeout(runSearch, 150);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) gotoPrevMatch();
      else gotoNextMatch();
    }
  });
  searchPrevBtn.addEventListener("click", gotoPrevMatch);
  searchNextBtn.addEventListener("click", gotoNextMatch);

  gotoBtn.addEventListener("click", () => {
    const n = parseInt(gotoInput.value, 10);
    if (!isNaN(n) && n >= 1) jumpToLine(n - 1, true);
  });
  gotoInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      gotoBtn.click();
    }
  });

  // ---------- Toolbar actions ----------

  function readFileData(files: FileList) {
    const file = files[0];
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      editorA.setText(text);
      localStorage.setItem(STORAGE_KEY, text);
      processText();
    };
    reader.readAsText(file);
  }

  filePicker.addEventListener("change", (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (files && files.length > 0) readFileData(files);
  });

  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    document.body.classList.add("ld-drag-active");
  });
  window.addEventListener("dragleave", (e) => {
    if (
      e.clientX <= 0 ||
      e.clientY <= 0 ||
      e.clientX >= window.innerWidth ||
      e.clientY >= window.innerHeight
    ) {
      document.body.classList.remove("ld-drag-active");
    }
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.classList.remove("ld-drag-active");
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) readFileData(files);
  });
  void dropZone;

  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      localStorage.setItem(STORAGE_KEY, editorA.getText());
      leftPanel.style.outline = "2px solid #4ade80";
      setTimeout(() => {
        leftPanel.style.outline = "";
      }, 2000);
    }
  });

  usageBtn.addEventListener("click", () => {
    usageModal.style.display = "flex";
  });
  usageClose.addEventListener("click", () => {
    usageModal.style.display = "none";
  });
  usageModal.addEventListener("click", (e) => {
    if (e.target === usageModal) usageModal.style.display = "none";
  });

  toggleBtn.addEventListener("click", () => {
    if (leftPanel.style.display !== "none") {
      leftPanel.style.display = "none";
      viewerScroll.style.width = "100%";
    } else {
      leftPanel.style.display = "flex";
      leftPanel.style.width = "50%";
      viewerScroll.style.width = "50%";
    }
    // The diff viewer's wrapped-line heights (rowHeights/rowTops) depend on
    // its pixel width via charsPerLine. Toggling the input panel changes
    // that width, so without this the browser re-wraps the text on its own
    // (fewer/more visual lines) while each row's own height/background -
    // computed from the old width - stays stale, leaving gaps or overlaps.
    if (diffLines.length > 0) recomputeLayoutAndRerender();
  });

  renderBtn.addEventListener("click", processText);

  // ---------- Initial load ----------

  const savedMode = localStorage.getItem(MODE_KEY);
  if (savedMode === "auto" || savedMode === "bilingual" || savedMode === "patch" || savedMode === "compare") {
    modeSelect.value = savedMode;
  }
  modeSelect.addEventListener("change", () => {
    localStorage.setItem(MODE_KEY, modeSelect.value);
    syncCompareUi();
    processText();
  });

  syncCompareUi();
  processText();
}
