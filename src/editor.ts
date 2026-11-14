import { Compartment, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
  rectangularSelection,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  StreamLanguage,
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
  completionKeymap,
} from "@codemirror/autocomplete";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { linter, lintGutter, lintKeymap, type Diagnostic } from "@codemirror/lint";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { diff as diffMode } from "@codemirror/legacy-modes/mode/diff";
import { oneDark } from "@codemirror/theme-one-dark";

export type LangId = "text" | "markdown" | "javascript" | "python" | "html" | "css" | "json" | "diff";

export const LANGUAGES: { id: LangId; label: string }[] = [
  { id: "text", label: "Plain text" },
  { id: "markdown", label: "Markdown" },
  { id: "diff", label: "Diff / patch" },
  { id: "javascript", label: "JavaScript / TS" },
  { id: "python", label: "Python" },
  { id: "html", label: "HTML" },
  { id: "css", label: "CSS" },
  { id: "json", label: "JSON" },
];

function languageExt(id: LangId): Extension {
  switch (id) {
    case "markdown":
      return markdown();
    case "javascript":
      return javascript({ jsx: true, typescript: true });
    case "python":
      return python();
    case "html":
      return html();
    case "css":
      return css();
    case "json":
      return json();
    case "diff":
      return StreamLanguage.define(diffMode);
    default:
      return [];
  }
}

/** Cheap structural linter: unmatched / unclosed brackets, skipping strings and comments. */
function bracketLint(id: LangId) {
  return (view: EditorView): Diagnostic[] => {
    const text = view.state.doc.toString();
    const out: Diagnostic[] = [];
    const stack: { ch: string; pos: number }[] = [];
    const open: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      const two = text.slice(i, i + 2);
      if (id === "javascript" && two === "//") {
        const nl = text.indexOf("\n", i);
        i = nl === -1 ? text.length : nl;
      } else if ((id === "javascript" || id === "css") && two === "/*") {
        const end = text.indexOf("*/", i + 2);
        i = end === -1 ? text.length : end + 2;
      } else if (id === "python" && c === "#") {
        const nl = text.indexOf("\n", i);
        i = nl === -1 ? text.length : nl;
      } else if (c === '"' || c === "'" || (c === "`" && id === "javascript")) {
        let j = i + 1;
        while (j < text.length && text[j] !== c && (c === "`" || text[j] !== "\n")) {
          if (text[j] === "\\") j++;
          j++;
        }
        i = j + 1;
      } else {
        if (c === "(" || c === "[" || c === "{") stack.push({ ch: c, pos: i });
        else if (c === ")" || c === "]" || c === "}") {
          const top = stack.pop();
          if (!top || top.ch !== open[c]) {
            out.push({ from: i, to: i + 1, severity: "warning", message: `Unmatched '${c}'` });
          }
        }
        i++;
      }
    }
    for (const s of stack) {
      out.push({ from: s.pos, to: s.pos + 1, severity: "warning", message: `Unclosed '${s.ch}'` });
    }
    return out;
  };
}

function lintExt(id: LangId): Extension {
  if (id === "json") return [linter(jsonParseLinter()), lintGutter()];
  if (id === "javascript" || id === "css" || id === "python") return [linter(bracketLint(id)), lintGutter()];
  return [];
}

// Brief highlight on a line (search hit / go-to-line).
const flashEffect = StateEffect.define<number | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        deco =
          e.value === null
            ? Decoration.none
            : Decoration.set([Decoration.line({ class: "cm-flash-line" }).range(e.value)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const layoutTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "14px" },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
    fontWeight: "500",
    lineHeight: "21px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-trailingSpace": { backgroundColor: "rgba(207, 34, 46, 0.12)" },
  ".cm-activeLine .cm-trailingSpace": { backgroundColor: "transparent" },
});

const lightTheme = EditorView.theme({
  "&": { backgroundColor: "#ffffff", color: "#24292f" },
  ".cm-content": { caretColor: "#d9774a" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#d9774a", borderLeftWidth: "2px" },
  ".cm-gutters": { backgroundColor: "#f6f8fa", color: "#8c959f", borderRight: "1px solid #d0d7de" },
  ".cm-activeLine": { backgroundColor: "rgba(9, 105, 218, 0.06)" },
  ".cm-activeLineGutter": { backgroundColor: "#eaeef2", color: "#24292f" },
});

// Centered chevron instead of the default text glyph (which sits below the baseline).
function foldMarker(open: boolean): HTMLElement {
  const el = document.createElement("span");
  el.className = open ? "ld-fold" : "ld-fold ld-fold-closed";
  el.innerHTML =
    '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return el;
}

const coreSetup: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter({ markerDOM: foldMarker }),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  search({ top: true }),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap,
  ]),
];

export interface Editor {
  view: EditorView;
  getText(): string;
  setText(text: string): void;
  setLanguage(id: LangId): void;
  setDark(dark: boolean): void;
  setPlaceholder(text: string): void;
  flashLine(line0: number, focus: boolean): void;
}

export interface EditorOptions {
  doc: string;
  placeholder: string;
  language: LangId;
  dark: boolean;
  onChange: () => void;
}

export function createEditor(parent: HTMLElement, opts: EditorOptions): Editor {
  const langC = new Compartment();
  const themeC = new Compartment();
  const phC = new Compartment();
  const themeFor = (dark: boolean): Extension => (dark ? oneDark : lightTheme);
  const langFor = (id: LangId): Extension => [languageExt(id), lintExt(id)];
  let flashTimer: number | undefined;

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        coreSetup,
        keymap.of([indentWithTab]),
        highlightTrailingWhitespace(),
        EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
        flashField,
        layoutTheme,
        themeC.of(themeFor(opts.dark)),
        langC.of(langFor(opts.language)),
        phC.of(placeholderExt(opts.placeholder)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange();
        }),
      ],
    }),
  });

  parent.classList.toggle("ld-cm-dark", opts.dark);

  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    setLanguage(id) {
      view.dispatch({ effects: langC.reconfigure(langFor(id)) });
    },
    setDark(dark) {
      parent.classList.toggle("ld-cm-dark", dark);
      view.dispatch({ effects: themeC.reconfigure(themeFor(dark)) });
    },
    setPlaceholder(text) {
      view.dispatch({ effects: phC.reconfigure(placeholderExt(text)) });
    },
    flashLine(line0, focus) {
      const doc = view.state.doc;
      const line = doc.line(Math.min(Math.max(line0, 0), doc.lines - 1) + 1);
      view.dispatch({
        effects: [EditorView.scrollIntoView(line.from, { y: "center" }), flashEffect.of(line.from)],
        ...(focus ? { selection: { anchor: line.from, head: line.to } } : {}),
      });
      if (focus) view.focus();
      window.clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), 1500);
    },
  };
}
