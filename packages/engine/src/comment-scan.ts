/**
 * why: Source scanner — the ONE literal/comment tokenizer behind both the engine
 * comment detectors (`./lint.ts`) and the ASCII-literal tooling
 * (`scripts/lint-ascii-literals.ts`, `scripts/escape-dist-literals.ts`,
 * `scripts/drift-lint.ts`).
 *
 * One pass classifies every character of a source file under a dialect:
 * - `c` (the default, so every existing caller is unchanged): `//` line
 *   comments and block comments (slash-star ... star-slash), with
 *   string/template/regex awareness;
 * - `hash` (Python, shell, Ruby): `#` opens a comment to end of line, and
 *   `//` is arithmetic or a path, never a comment.
 *
 * String awareness (single, double, backtick) with template `${}` expressions
 * scanned as code, so their own literals and comments classify correctly.
 * Regex-literal awareness (a char class may hold a quote, e.g. /["'`]/) keeps
 * a quote inside a regex from opening a phantom string.
 *
 * Regex-vs-division is a heuristic: after an adjacent `++`/`--`, after a
 * completed regex, after a closed string or template, or after an operand,
 * `/` divides, so a trailing `//` still opens a line comment
 * (`i++ / 2 // note`, `"4" / 2 // note`).
 */

/** Scan class of a character. */
export const SOURCE_CODE = 0;
export const SOURCE_COMMENT = 1;
export const SOURCE_LITERAL = 2;

/**
 * The comment syntax a file is read with.
 * - `c`: double-slash line comments and slash-star block comments, with
 *   regex-literal awareness.
 * - `hash`: `#` opens a comment to end of line, and the double slash is
 *   arithmetic (Python floor division) or a path (shell) — never a comment.
 *   No regex literals exist, so a single slash always divides.
 */
export type SourceDialect = "c" | "hash";

/** Classify every character of `src` under `dialect`: code, comment content,
 * or string, template, or regex literal content (delimiters and escapes
 * included). */
export function scanSource(src: string, dialect: SourceDialect = "c"): Uint8Array {
  const scan = new Uint8Array(src.length);
  let state: "code" | "line" | "block" | "sq" | "dq" | "tpl" | "regex" = "code";
  const exprStack: Array<"expr" | "brace"> = []; // template ${...} / object-literal braces
  let regexInClass = false;
  let prevSig = ""; // last significant char emitted in code state (regex heuristic)
  let lastToken = ""; // last identifier emitted in code state (regex keyword heuristic)
  let i = 0;
  const regexAntecedent: Record<string, true> = {
    "(": true, "[": true, "{": true, ",": true, ";": true, ":": true, "=": true, "!": true,
    "&": true, "|": true, "?": true, "+": true, "-": true, "*": true, "%": true, "<": true,
    ">": true, "~": true, "^": true, "/": true,
  };
  const regexKeywords: Record<string, true> = {
    return: true, case: true, throw: true, typeof: true, instanceof: true, in: true,
    of: true, new: true, delete: true, void: true, do: true, else: true, yield: true, await: true,
  };
  while (i < src.length) {
    const c = src[i];
    const next = i + 1 < src.length ? src[i + 1] : "";
    if (state === "line") {
      if (c === "\n") state = "code";
      else scan[i] = SOURCE_COMMENT;
      i++;
      continue;
    }
    if (state === "block") {
      scan[i] = SOURCE_COMMENT;
      if (c === "*" && next === "/") {
        scan[i + 1] = SOURCE_COMMENT;
        i += 2;
        state = "code";
      } else {
        i++;
      }
      continue;
    }
    if (state === "sq" || state === "dq") {
      scan[i] = SOURCE_LITERAL;
      const quote = state === "sq" ? "'" : '"';
      if (c === "\\") {
        if (next !== "") scan[i + 1] = SOURCE_LITERAL;
        i += 2; // skip escape + escaped char
        continue;
      }
      // A quote literal never spans a line: an unterminated one (an apostrophe
      // in prose the scanner read as code) bails to code, so the phantom string
      // cannot blank the rest of the file — comment content included.
      if (c === quote || c === "\n") {
        state = "code";
        // The literal is a complete operand: a following `/` is division, not
        // a regex (else `const n = "4" / 2 // note` swallows the line comment).
        prevSig = ")";
        lastToken = "";
      }
      i++;
      continue;
    }
    if (state === "tpl") {
      scan[i] = SOURCE_LITERAL;
      if (c === "\\") {
        if (next !== "") scan[i + 1] = SOURCE_LITERAL;
        i += 2;
        continue;
      }
      if (c === "`") {
        state = "code";
        // A closed template is a complete operand — a following `/` divides.
        prevSig = ")";
        lastToken = "";
        i++;
        continue;
      }
      if (c === "$" && next === "{") {
        scan[i + 1] = SOURCE_LITERAL;
        exprStack.push("expr");
        state = "code";
        prevSig = "("; // a template expression may open with a regex
        lastToken = "";
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (state === "regex") {
      scan[i] = SOURCE_LITERAL;
      if (c === "\\") {
        if (next !== "") scan[i + 1] = SOURCE_LITERAL;
        i += 2;
        continue;
      }
      if (c === "[") regexInClass = true;
      else if (c === "]" && regexInClass) regexInClass = false;
      else if (c === "/" && !regexInClass) {
        state = "code";
        // ")": the regex is a complete operand — a following `/` is division,
        // not a regex (else `x = /a/ / 2 // note` swallows the line comment).
        prevSig = ")";
        lastToken = "";
        i++;
        continue;
      } else if (c === "\n") {
        // unterminated regex — bail to code so the rest of the line scans normally
        state = "code";
        prevSig = ")";
        lastToken = "";
        i++;
        continue;
      }
      i++;
      continue;
    }
    // state === "code"
    // why: in a hash-comment language `#` opens the line comment and `//` is
    // arithmetic (Python floor division) or a path (shell), so C rules would
    // read `return n // d` as a comment. A marker after `{` or `$`
    // (`${#SCREENS[@]}`, `$#`) is shell syntax, so the introducer must follow
    // whitespace or open the line.
    // shortcut: an unspaced trailing `#` (`x=1#note`) opens no comment.
    // upgrade: a per-language tokenizer with each grammar's own word rules.
    // why: `#!` on line 1 is an execution directive the kernel reads, not
    // prose about the code, so it stays code in a hash dialect.
    if (dialect === "hash" && c === "#" && !(i === 0 && next === "!") && (i === 0 || /\s/.test(src[i - 1] as string))) {
      state = "line";
      scan[i] = SOURCE_COMMENT;
      i++;
      continue;
    }
    if (dialect === "c" && c === "/" && next === "/") {
      state = "line";
      scan[i] = SOURCE_COMMENT;
      scan[i + 1] = SOURCE_COMMENT;
      i += 2;
      continue;
    }
    if (dialect === "c" && c === "/" && next === "*") {
      state = "block";
      scan[i] = SOURCE_COMMENT;
      scan[i + 1] = SOURCE_COMMENT;
      i += 2;
      continue;
    }
    if (c === "/") {
      // why: a hash-comment language has no regex literals, so a slash always
      // divides and `//` stays two of them. Entering the regex state there
      // would swallow the rest of the line.
      const startsRegex = dialect === "c" && (Object.hasOwn(regexAntecedent, prevSig) || Object.hasOwn(regexKeywords, lastToken) || prevSig === "");
      if (startsRegex) {
        state = "regex";
        regexInClass = false;
        i++;
        continue;
      }
      prevSig = c;
      lastToken = "";
      i++;
      continue;
    }
    if (c === "'") {
      state = "sq";
      i++;
      continue;
    }
    if (c === '"') {
      state = "dq";
      i++;
      continue;
    }
    if (c === "`") {
      state = "tpl";
      i++;
      continue;
    }
    if (c === "{") {
      if (exprStack.length > 0) exprStack.push("brace");
      prevSig = c;
      lastToken = "";
      i++;
      continue;
    }
    if (c === "}") {
      const top = exprStack[exprStack.length - 1];
      if (top === "brace") {
        exprStack.pop();
        prevSig = c;
        lastToken = "";
        i++;
        continue;
      }
      if (top === "expr") {
        exprStack.pop();
        state = "tpl"; // back inside the template literal that opened this expression
        prevSig = c;
        lastToken = "";
        i++;
        continue;
      }
      prevSig = c;
      lastToken = "";
      i++;
      continue;
    }
    // Track identifier tokens + significant chars for the regex heuristic.
    if (/[A-Za-z0-9_$]/.test(c)) {
      lastToken += c;
      prevSig = c;
    } else if (!/\s/.test(c)) {
      if ((c === "+" || c === "-") && prevSig === c && src[i - 1] === c) {
        // Adjacent `++` / `--`: the operand is complete, so a following `/`
        // is division, not a regex — else `i++ / 2 // note` would enter the
        // regex state, consume the line comment's slashes, and leave the
        // comment content unmasked. ")" = operand position.
        prevSig = ")";
      } else {
        prevSig = c;
      }
      lastToken = "";
    }
    i++;
  }
  return scan;
}

/** 1 where the character is comment content (the ASCII tooling's view). */
export function commentMask(src: string, dialect: SourceDialect = "c"): Uint8Array {
  const scan = scanSource(src, dialect);
  const mask = new Uint8Array(src.length);
  for (let i = 0; i < scan.length; i++) {
    if (scan[i] === SOURCE_COMMENT) mask[i] = 1;
  }
  return mask;
}

/** String, template and regex literal content blanked to spaces (newlines
 * kept, so line numbers survive), comments left intact — the detectors' view:
 * a marker token inside a literal is not a marker, a marker inside a comment
 * still is. */
export function maskLiterals(src: string, dialect: SourceDialect = "c"): string {
  // why: one file runs five comment finders (markers, temporary, TODO,
  // commented-out code, unclassified) and each needs this same view; a
  // single-entry cache makes it one scan per file instead of five. Measured
  // over the 824-file corpus: 1732ms for five passes vs 428ms for one; re-run
  // with a loop over the collected texts if the finder set changes.
  if (maskCache !== null && maskCache.text === src && maskCache.dialect === dialect) return maskCache.masked;
  const scan = scanSource(src, dialect);
  let out = "";
  for (let i = 0; i < src.length; i++) {
    out += scan[i] === SOURCE_LITERAL && src[i] !== "\n" ? " " : src[i];
  }
  maskCache = { text: src, dialect, masked: out };
  return out;
}

/** why: the cache holds the file being linted, never the corpus - one entry, replaced on the next text. */
let maskCache: { text: string; dialect: SourceDialect; masked: string } | null = null;
