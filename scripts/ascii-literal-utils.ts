/**
 * Shared comment-masking state machine for the ASCII-literal tooling
 * (`scripts/lint-ascii-literals.ts`, `scripts/escape-dist-literals.ts`).
 *
 * Marks every source position that lies inside a comment. Naive state
 * machine: `//` line comments and block comments (slash-star … star-slash),
 * with string awareness (single/double/backtick + template `${}` expressions)
 * and regex-literal awareness (a regex char class may contain quote
 * characters, e.g. `/["'\`]/`), so a `//` inside a literal never starts a
 * comment and a quote inside a regex never opens a string. Regex-vs-division
 * is a heuristic: after an adjacent `++`/`--` or after a regex literal ends,
 * `/` is treated as division so a trailing `//` still opens a line comment
 * (`i++ / 2 // 注释`). Returns a Uint8Array of the same length as `src`
 * (1 = inside comment).
 */
export function commentMask(src: string): Uint8Array {
  const mask = new Uint8Array(src.length);
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
      else mask[i] = 1;
      i++;
      continue;
    }
    if (state === "block") {
      mask[i] = 1;
      if (c === "*" && next === "/") {
        mask[i + 1] = 1;
        i += 2;
        state = "code";
      } else {
        i++;
      }
      continue;
    }
    if (state === "sq" || state === "dq") {
      const quote = state === "sq" ? "'" : '"';
      if (c === "\\") {
        i += 2; // skip escape + escaped char
        continue;
      }
      if (c === quote) state = "code";
      i++;
      continue;
    }
    if (state === "tpl") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        state = "code";
        i++;
        continue;
      }
      if (c === "$" && next === "{") {
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
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "[") regexInClass = true;
      else if (c === "]" && regexInClass) regexInClass = false;
      else if (c === "/" && !regexInClass) {
        state = "code";
        // ")": the regex is a complete operand — a following `/` is division,
        // not a regex (else `x = /a/ / 2 // 注释` swallows the line comment).
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
      mask[i] = 1;
      mask[i + 1] = 1;
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      state = "block";
      mask[i] = 1;
      mask[i + 1] = 1;
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
        // is division, not a regex — else `i++ / 2 // 注释` would enter the
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
  return mask;
}
