// Bundled to ui/vendor/codemirror.js (npm run build:ui) so the UI needs no build step at runtime.
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { sql, PostgreSQL, MySQL, MariaSQL, SQLite, MSSQL, StandardSQL } from "@codemirror/lang-sql";
import { linter, lintGutter, forceLinting } from "@codemirror/lint";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const dialects = { postgresql: PostgreSQL, mysql: MySQL, mariadb: MariaSQL, sqlite: SQLite, mssql: MSSQL, standard: StandardSQL };

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--cm-keyword)", fontWeight: "600" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--cm-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--cm-number)" },
  { tag: tags.comment, color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: [tags.typeName, tags.standard(tags.name)], color: "var(--cm-type)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--muted)" },
  { tag: tags.special(tags.name), color: "var(--cm-type)" },
]);

const theme = EditorView.theme({
  "&": { backgroundColor: "var(--bg-2)", color: "var(--fg)", fontSize: "13px", height: "100%" },
  ".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", caretColor: "var(--fg)" },
  ".cm-gutters": { backgroundColor: "var(--bg-2)", color: "var(--muted)", borderRight: "1px solid var(--border)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent) !important" },
  ".cm-tooltip": { backgroundColor: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: "6px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--accent-fg)" },
  ".cm-scroller": { overflow: "auto" },
});

/**
 * createSqlEditor(parent, { doc, dialect, schema, defaultTable, onRun, lint })
 * lint: async (sql) => [{ from, to, message, severity }]
 */
function createSqlEditor(parent, opts) {
  const lang = new Compartment();
  const langFor = (dialect, schema) =>
    sql({ dialect: dialects[dialect] || StandardSQL, schema: schema || {}, upperCaseKeywords: false });
  const run = () => { opts.onRun && opts.onRun(); return true; };
  const extensions = [
    basicSetup,
    Prec.highest(keymap.of([{ key: "Mod-Enter", run, preventDefault: true }])),
    lang.of(langFor(opts.dialect, opts.schema)),
    syntaxHighlighting(highlight),
    theme,
    EditorView.lineWrapping,
  ];
  if (opts.lint) {
    extensions.push(lintGutter(), linter(async (view) => {
      const text = view.state.doc.toString();
      if (!text.trim()) return [];
      try {
        const diags = await opts.lint(text);
        if (view.state.doc.toString() !== text) return [];
        const len = view.state.doc.length;
        return diags.map((d) => ({ ...d, from: Math.min(d.from, len), to: Math.min(Math.max(d.to, d.from + 1), len) }));
      } catch { return []; }
    }, { delay: 600 }));
  }
  const view = new EditorView({ parent, state: EditorState.create({ doc: opts.doc || "", extensions }) });
  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    getSelection: () => { const s = view.state.selection.main; return view.state.sliceDoc(s.from, s.to); },
    focus: () => view.focus(),
    setSchema: (dialect, schema) => view.dispatch({ effects: lang.reconfigure(langFor(dialect, schema)) }),
    relint: () => forceLinting(view),
  };
}

window.StudioCM = { createSqlEditor };
