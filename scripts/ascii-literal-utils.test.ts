/**
 * scripts/ascii-literal-utils.ts — commentMask guard semantics (QC fix wave 3:
 * qc1 F-001 + qc2 W-1/S-2 + qc3 F-1). Pins the shared comment-masking state
 * machine that gates BOTH the src lint and the dist escaper:
 * - a `//` inside a string (URL) never opens a line comment;
 * - block comments span lines;
 * - the regex-vs-division heuristic: `/` after an adjacent `++`/`--` or after
 *   a regex literal is division, so a trailing `// 注释` still opens a line
 *   comment (qc3 F-1 false-positive regression: `i++ / 2 // 中文注释` used to
 *   report the comment text as code);
 * - a quote inside a regex char class never opens a string;
 * - a `//` inside a template `${}` expression or template text is content,
 *   not a comment;
 * - non-ASCII in real code (not comments) stays unmasked.
 */
import { describe, expect, test } from "bun:test";
import { commentMask } from "./ascii-literal-utils.ts";

/** Non-ASCII characters at positions the mask treats as CODE (not comment). */
function unmaskedNonAscii(src: string): string {
  const mask = commentMask(src);
  let out = "";
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) > 0x7f && mask[i] === 0) out += src[i];
  }
  return out;
}

/** The exact text of every masked (comment) region. */
function maskedText(src: string): string {
  const mask = commentMask(src);
  let out = "";
  for (let i = 0; i < src.length; i++) {
    if (mask[i] === 1) out += src[i];
  }
  return out;
}

describe("commentMask — string awareness: `//` inside a literal never opens a comment", () => {
  test("URL https:// inside a string, trailing comment masked", () => {
    const src = 'const u = "https://example.com/a?x=1"; // 尾注\n';
    expect(unmaskedNonAscii(src)).toBe("");
    expect(maskedText(src)).toContain("尾注");
  });

  test("// inside a template literal is content, trailing comment still masked", () => {
    const src = "const s = `a${x} // b`; // 注释\n";
    expect(unmaskedNonAscii(src)).toBe("");
    expect(maskedText(src)).toContain("注释");
    expect(maskedText(src)).not.toContain("// b");
  });
});

describe("commentMask — block comments", () => {
  test("block comment spans lines and masks non-ASCII inside", () => {
    const src = "const x = 1; /* 块注释\n跨行 */\n";
    expect(unmaskedNonAscii(src)).toBe("");
    expect(maskedText(src)).toContain("块注释\n跨行");
  });
});

describe("commentMask — regex vs division heuristic (qc3 F-1 regression)", () => {
  test("division after i++ no longer swallows the trailing // comment", () => {
    const src = "i++ / 2 // 中文注释\n";
    expect(unmaskedNonAscii(src)).toBe("");
    expect(maskedText(src)).toContain("中文注释");
  });

  test("division after i++ directly followed by // with no space", () => {
    const src = "i++ / 2 //中文注释\n";
    expect(unmaskedNonAscii(src)).toBe("");
    expect(maskedText(src)).toContain("中文注释");
  });

  test("siblings: i-- and prefix ++/-- before a division", () => {
    for (const src of ["i-- / 2 // 注释\n", "++i / 2 // 注释\n", "--x / 2 // 注释\n", "i++/2 // 注释\n"]) {
      expect(unmaskedNonAscii(src)).toBe("");
      expect(maskedText(src)).toContain("注释");
    }
  });

  test("division after a regex literal keeps the trailing // comment (regex-close heuristic)", () => {
    const src = "x = /re/ / 2 // 注释\n";
    expect(unmaskedNonAscii(src)).toBe("");
    expect(maskedText(src)).toContain("注释");
  });

  test("spaced + + stays unary plus: regex after it still opens", () => {
    const src = "const u = a + +/re/.test(x); // 注释\n";
    expect(unmaskedNonAscii(src)).toBe("");
    expect(maskedText(src)).toContain("注释");
  });

  test("plain division and plain regex both leave the trailing comment masked", () => {
    expect(unmaskedNonAscii("const d = a / b; // 注释\n")).toBe("");
    expect(unmaskedNonAscii("const r = /ab/; // 注释\n")).toBe("");
  });

  test("division with no trailing comment has no masked region", () => {
    expect(maskedText("const d = a / b;\n")).toBe("");
  });
});

describe("commentMask — regex char class with quote characters", () => {
  test("quotes inside a regex char class do not open strings", () => {
    const src = 'const re = /["\'`]/; // 注释\n';
    expect(unmaskedNonAscii(src)).toBe("");
    expect(maskedText(src)).toContain("注释");
  });
});

describe("commentMask — non-ASCII in real code stays unmasked", () => {
  test("non-ASCII inside a string literal is code, not comment", () => {
    expect(unmaskedNonAscii('const s = "中文";\n')).toBe("中文");
  });
});
