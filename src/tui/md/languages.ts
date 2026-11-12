/**
 * The per-language tables for the highlighter: comment and string forms, keywords, types and constants. One small
 * tokenizer reads them all (code.ts); a few languages have a line-level mode on top (markup, YAML, diff, shells).
 */

export interface StringForm {
  open: string;
  close: string;
  /** May span lines. */
  multiline?: boolean;
  /** Backslash escapes the next character. */
  escape?: boolean;
}

export interface Lang {
  name: string;
  lineComment?: string[];
  /** `#` starts a comment only at a line start or after whitespace (shells, YAML, TOML). */
  hashNeedsSpace?: boolean;
  blockComment?: [string, string][];
  strings: StringForm[];
  keywords: Set<string>;
  types?: Set<string>;
  constants?: Set<string>;
  caseInsensitive?: boolean;
  /** An identifier starting with a capital letter is a type. */
  capitalTypes?: boolean;
  /** `$name`, `${…}` are variables (shells, Dockerfile). */
  dollarVars?: boolean;
  /** `@name` is a decorator / attribute. */
  decorators?: boolean;
  /** `name!` is a macro call (Rust). */
  macros?: boolean;
  /** `'` starts a character literal only when it closes within a few characters (Rust lifetimes). */
  charQuote?: boolean;
  /** A string followed by `:` is a key (JSON). */
  keyStrings?: boolean;
  /** Identifiers may contain `-` (CSS, shells' flags). */
  dashIdents?: boolean;
  mode?: "markup" | "yaml" | "toml" | "diff" | "markdown" | "docker" | "css" | "console";
}

const set = (words: string): Set<string> => new Set(words.split(/\s+/).filter(Boolean));

const C_STRINGS: StringForm[] = [
  { open: '"', close: '"', escape: true },
  { open: "'", close: "'", escape: true },
];

const JS_KEYWORDS = set(`
  abstract as async await break case catch class const continue debugger declare default delete do else enum export
  extends finally for from function get if implements import in infer instanceof interface is keyof let module
  namespace new of package private protected public readonly return satisfies set static super switch this throw try
  type typeof var void while with yield`);
const JS_TYPES = set(`
  string number boolean bigint symbol object unknown never any void Array Promise Map Set WeakMap WeakSet Record
  Partial Required Readonly Pick Omit Exclude Extract ReturnType Parameters Awaited Date RegExp Error JSON Math Object
  String Number Boolean Symbol BigInt Function console process globalThis window document`);
const JS_CONSTANTS = set("true false null undefined NaN Infinity");

const ts: Lang = {
  name: "typescript",
  lineComment: ["//"],
  blockComment: [["/*", "*/"]],
  strings: [...C_STRINGS, { open: "`", close: "`", multiline: true, escape: true }],
  keywords: JS_KEYWORDS,
  types: JS_TYPES,
  constants: JS_CONSTANTS,
  capitalTypes: true,
  decorators: true,
};

const json: Lang = {
  name: "json",
  lineComment: ["//"],
  blockComment: [["/*", "*/"]],
  strings: C_STRINGS,
  keywords: new Set(),
  constants: set("true false null"),
  keyStrings: true,
};

const python: Lang = {
  name: "python",
  lineComment: ["#"],
  strings: [
    { open: '"""', close: '"""', multiline: true, escape: true },
    { open: "'''", close: "'''", multiline: true, escape: true },
    ...C_STRINGS,
  ],
  keywords: set(`
    and as assert async await break class continue def del elif else except finally for from global if import in is
    lambda nonlocal not or pass raise return try while with yield match case type`),
  types: set(`
    int float str bool bytes list dict set tuple frozenset object type complex range print len open isinstance
    super self cls Exception ValueError TypeError KeyError RuntimeError Optional List Dict Any Union`),
  constants: set("True False None NotImplemented Ellipsis"),
  capitalTypes: true,
  decorators: true,
};

const SHELL_KEYWORDS = set(`
  if then else elif fi for in do done case esac while until function select return export local declare readonly
  unset set shift exit break continue time`);
const SHELL_BUILTINS = set(`
  echo cd printf read test source eval exec alias cat ls grep sed awk find xargs curl wget git npm npx pnpm yarn node
  bun deno python python3 pip make docker kubectl sudo chmod chown mkdir rm cp mv touch tar ssh brew apt go cargo
  rustc memtro env which kill trap wait true false`);

const shell: Lang = {
  name: "shell",
  lineComment: ["#"],
  hashNeedsSpace: true,
  strings: [
    { open: '"', close: '"', escape: true, multiline: true },
    { open: "'", close: "'", multiline: true },
  ],
  keywords: SHELL_KEYWORDS,
  types: SHELL_BUILTINS,
  dollarVars: true,
  dashIdents: true,
};

const go: Lang = {
  name: "go",
  lineComment: ["//"],
  blockComment: [["/*", "*/"]],
  strings: [...C_STRINGS, { open: "`", close: "`", multiline: true }],
  keywords: set(`
    break case chan const continue default defer else fallthrough for func go goto if import interface map package
    range return select struct switch type var`),
  types: set(`
    bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32
    uint64 uintptr any comparable append cap close copy delete len make new panic print println recover`),
  constants: set("true false nil iota"),
  capitalTypes: true,
};

const rust: Lang = {
  name: "rust",
  lineComment: ["//"],
  blockComment: [["/*", "*/"]],
  strings: [{ open: '"', close: '"', escape: true, multiline: true }],
  keywords: set(`
    as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref
    return self Self static struct super trait type unsafe use where while`),
  types: set(`
    i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc
    HashMap HashSet BTreeMap Some None Ok Err`),
  constants: set("true false"),
  capitalTypes: true,
  macros: true,
  charQuote: true,
  decorators: false,
};

const sql: Lang = {
  name: "sql",
  lineComment: ["--"],
  blockComment: [["/*", "*/"]],
  strings: [
    { open: "'", close: "'", multiline: true },
    { open: '"', close: '"' },
  ],
  keywords: set(`
    select from where and or not insert into values update set delete create table index view drop alter add column
    primary key foreign references join inner left right full outer cross on as group by order having limit offset
    union all distinct case when then else end is null like ilike in exists between with returning begin commit
    rollback transaction grant revoke cascade constraint unique default check if asc desc using lateral over
    partition window filter conflict do nothing explain analyze vacuum trigger function returns language`),
  types: set(`
    int integer bigint smallint serial bigserial text varchar char boolean bool date time timestamp timestamptz
    interval numeric decimal real double precision json jsonb uuid bytea array count sum avg min max coalesce now`),
  constants: set("true false null"),
  caseInsensitive: true,
};

const yaml: Lang = {
  name: "yaml",
  lineComment: ["#"],
  hashNeedsSpace: true,
  strings: [
    { open: '"', close: '"', escape: true },
    { open: "'", close: "'" },
  ],
  keywords: new Set(),
  constants: set("true false null yes no on off True False Null TRUE FALSE NULL ~"),
  mode: "yaml",
};

const toml: Lang = {
  name: "toml",
  lineComment: ["#"],
  strings: [
    { open: '"""', close: '"""', multiline: true, escape: true },
    { open: "'''", close: "'''", multiline: true },
    { open: '"', close: '"', escape: true },
    { open: "'", close: "'" },
  ],
  keywords: new Set(),
  constants: set("true false inf nan"),
  mode: "toml",
};

const markup: Lang = {
  name: "html",
  blockComment: [["<!--", "-->"]],
  strings: C_STRINGS,
  keywords: new Set(),
  mode: "markup",
};

const css: Lang = {
  name: "css",
  blockComment: [["/*", "*/"]],
  lineComment: [],
  strings: C_STRINGS,
  keywords: set("important"),
  constants: set("inherit initial unset none auto"),
  dashIdents: true,
  mode: "css",
};

const markdown: Lang = { name: "markdown", strings: [], keywords: new Set(), mode: "markdown" };

const docker: Lang = {
  name: "dockerfile",
  lineComment: ["#"],
  hashNeedsSpace: true,
  strings: C_STRINGS,
  keywords: set(`
    FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL
    HEALTHCHECK SHELL AS`),
  types: SHELL_BUILTINS,
  dollarVars: true,
  dashIdents: true,
  mode: "docker",
};

const diff: Lang = { name: "diff", strings: [], keywords: new Set(), mode: "diff" };
const consoleLang: Lang = { ...shell, name: "console", mode: "console" };

/** Fence words (and common aliases) to a language. */
const ALIASES: Record<string, Lang> = {};
const alias = (lang: Lang, names: string) => {
  for (const n of names.split(/\s+/).filter(Boolean)) ALIASES[n] = lang;
};
alias(ts, "ts typescript tsx js javascript jsx mjs cjs mts cts es6 node deno");
alias(json, "json jsonc json5 jsonl ndjson geojson webmanifest");
alias(python, "py python python3 py3 gyp pyi");
alias(shell, "sh bash zsh shell fish ksh ash dash bashrc zshrc env dotenv");
alias(consoleLang, "console shell-session shellsession terminal sh-session bash-session");
alias(go, "go golang");
alias(rust, "rs rust");
alias(sql, "sql psql pgsql postgres postgresql mysql sqlite plsql tsql");
alias(yaml, "yaml yml");
alias(toml, "toml ini cfg conf editorconfig gitconfig");
alias(markup, "html htm xml svg xhtml vue svelte astro plist xsl rss atom");
alias(css, "css scss sass less postcss");
alias(markdown, "md markdown mdx mkd");
alias(docker, "dockerfile docker containerfile");
alias(diff, "diff patch udiff");

/** File extensions seen as a fence's first word (```src/app.ts) to the alias that names their language. */
const EXTENSIONS: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "mjs", cjs: "cjs", json: "json", py: "py", sh: "sh", bash: "sh",
  zsh: "sh", go: "go", rs: "rs", sql: "sql", yaml: "yaml", yml: "yaml", toml: "toml", html: "html", xml: "xml",
  css: "css", scss: "css", md: "md", mdx: "mdx", diff: "diff", patch: "diff", svg: "svg", vue: "vue",
};

export function findLanguage(name: string | undefined): Lang | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  return ALIASES[key] ?? (key === "dockerfile" ? docker : null);
}

/**
 * A fence's info string to the language word and a title: ```ts title="src/app.ts"```, ```bash npm``` (Mintlify's
 * code group label), ```ts:src/app.ts```, ```src/app.ts``` (a file name: language from its extension),
 * ```js {1,3-4}``` (line highlights, ignored).
 */
export function parseInfo(info: string): { lang: string; title: string } {
  const text = info.trim();
  if (!text) return { lang: "", title: "" };
  const titleAttr = /(?:^|\s)(?:title|filename|file|name)=(?:"([^"]*)"|'([^']*)'|(\S+))/i.exec(text);
  let title = titleAttr ? (titleAttr[1] ?? titleAttr[2] ?? titleAttr[3] ?? "") : "";
  const words = text.replace(/\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean);
  let lang = words[0] ?? "";
  if (lang.includes("=")) lang = "";
  const colon = /^([\w+#-]+):(.+)$/.exec(lang);
  if (colon && findLanguage(colon[1])) {
    lang = colon[1]!;
    if (!title) title = colon[2]!;
  }
  if (lang && !findLanguage(lang) && /[./]/.test(lang)) {
    const ext = /\.([A-Za-z0-9]+)$/.exec(lang)?.[1]?.toLowerCase();
    if (!title) title = lang;
    lang = (ext && EXTENSIONS[ext]) || (/(^|\/)Dockerfile$/i.test(lang) ? "dockerfile" : "");
  }
  if (!title) {
    const second = words[1];
    if (second && !second.includes("=")) title = words.slice(1).filter((w) => !w.includes("=")).join(" ");
  }
  return { lang: lang.replace(/^\{|\}$/g, ""), title };
}
