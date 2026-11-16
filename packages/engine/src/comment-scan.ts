/**
 * Source scanner — the ONE literal/comment tokenizer behind both the engine
 * comment detectors (`./lint.ts`) and the ASCII-literal tooling
 * (`scripts/lint-ascii-literals.ts`, `scripts/escape-dist-literals.ts`,
 * `scripts/drift-lint.ts`).
 *
 * One pass classifies every character of a source file:
 * - `//` line comments and block comments (slash-star ... star-slash);
 * - string awareness (single, double, backtick), with template `${}`
 *   expressions scanned as code so their own literals and comments classify
 *   correctly;
 * - regex-literal awareness (a char class may hold a quote, e.g. /["'`]/), so
 *   a quote inside a regex never opens a phantom string.
 *
 * Regex-vs-division is a heuristic: after an adjacent `++`/`--`, after a
 * completed regex, or after an operand, `/` divides, so a trailing `//` still
 * opens a line comment (`i++ / 2 // note`).
 */

/** Scan class of a character. */
export const SOURCE_CODE = 0;
export const SOURCE_COMMENT = 1;
export const SOURCE_LITERAL = 2;

/** Classify every character of `src`: code, comment content, or string,
 * template, or regex literal content (delimiters and escapes included). */
export function scanSource(src: string): Uint8Array {
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
      if (c === quote) state = "code";
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
    if (c === "/" && next === "/") {
      state = "line";
      scan[i] = SOURCE_COMMENT;
      scan[i + 1] = SOURCE_COMMENT;
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      state = "block";
      scan[i] = SOURCE_COMMENT;
      scan[i + 1] = SOURCE_COMMENT;
      i += 2;
      continue;
    }
    if (c === "/") {
      const startsRegex = Object.hasOwn(regexAntecedent, prevSig) || Object.hasOwn(regexKeywords, lastToken) || prevSig === "";
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
export function commentMask(src: string): Uint8Array {
  const scan = scanSource(src);
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
export function maskLiterals(src: string): string {
  const scan = scanSource(src);
  let out = "";
  for (let i = 0; i < src.length; i++) {
    out += scan[i] === SOURCE_LITERAL && src[i] !== "\n" ? " " : src[i];
  }
  return out;
}
