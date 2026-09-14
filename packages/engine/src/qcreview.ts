/**
 * qcreview — QC 席位报告契约（review-seat return side）。
 *
 * spec: `mstar-review-qc` SKILL.md § 席位预算与截断（该节 callout 声明的
 * `qc validate-report`）、`report-template.md` § Frontmatter / § Report body
 * template / § Findings（verdict 词表与报告形状逐字来源）、
 * `qc-specialist-shared.md` § Budget and stopping / § Targeted re-review
 * （就地 revalidation 刷新当前状态，报告只有一份计数）。
 *
 * 机器可判定的十条规则（violation code 前缀一律 `qcreview.report.`）：
 * 1. `missing-frontmatter` — 报告必须以 `---` 围栏 frontmatter 开头。
 * 2. `missing-<field>` — `report_kind` / `reviewer` / `reviewer_index` /
 *    `plan_id` / `verdict` / `generated_at` 缺失或空值。
 * 3. `invalid-report-kind` — `report_kind` 必须是 `qc`。
 * 4. `invalid-verdict` — frontmatter `verdict` 必须逐字属于 `QC_VERDICTS`。
 * 5. `invalid-generated-at` — `generated_at` 必须是日历日期 `YYYY-MM-DD`。
 * 6. `missing-body-verdict` — 正文必须有 verdict 行。
 * 7. `verdict-mismatch` — 正文 verdict 取词必须属于 `QC_VERDICTS` 且与
 *    frontmatter verdict 一致；允许尾随散文（真实报告写
 *    `**Verdict**: Approve. The diff keeps ...`，历史上还出现
 *    `## Verdict: **Approve with residuals**`）。
 * 8. `summary-count-mismatch` — `## Summary` 计数必须等于 `## Findings`
 *    对应 severity 分区的顶层条目数（`None.` = 0）。`## Summary` 是报告
 *    唯一的当前计数：就地 revalidation 刷新它与 `## Findings`，
 *    `## Revalidation` 只记过程与逐 finding 处置，不另立计数。
 * 9. `verdict-contradicts-counts` — Critical / Warning 计数 > 0 不允许
 *    `Approve`；Unconfirmed 计数 > 0 要求 verdict 为 `Unconfirmed`。
 * 10. `truncation-verdict` — 已声明 `Truncated coverage:` 行时 verdict 不得为
 *    `Unconfirmed`（截断是范围收缩，不是证据通道失败）。
 *
 * 不可判定即静默：形状未文档化（分区或计数行缺失、计数单元格非数字、
 * frontmatter verdict 本身非法）时不出 violation，绝不猜测；每条 violation
 * 都带可执行的 `fix`。
 */
import type { GateResult, Severity, ValidationResult } from "./core.js";
import { lines_missing_fence, parseReportFrontmatter } from "./prreview.js";

/**
 * Verdict 词表 —— 逐字取自 `report-template.md` § Report body template。
 * `Unconfirmed` 是证据通道失败态（不是"未审"），预算截断不得用它。
 */
export const QC_VERDICTS = ["Approve", "Request Changes", "Needs Discussion", "Unconfirmed"] as const;

/** 席位报告 verdict 取值（`QC_VERDICTS` 成员）。 */
export type QcVerdict = (typeof QC_VERDICTS)[number];

/** Frontmatter 必填字段（`report-template.md` \u00a7 Frontmatter，经 `qc-specialist-shared.md`）。 */
const REPORT_FIELDS = ["report_kind", "reviewer", "reviewer_index", "plan_id", "verdict", "generated_at"] as const;

/** `generated_at` 为日历日期 `YYYY-MM-DD`（模板给出 `"2026-09-14"` 形状）。 */
const REPORT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `## Summary` 四行计数与 `## Findings` 四个 severity 分区，模板顺序。 */
const REPORT_SEVERITIES = ["Critical", "Warning", "Suggestion", "Unconfirmed"] as const;
type ReportSeverity = (typeof REPORT_SEVERITIES)[number];

/**
 * 正文 verdict 行：`**Verdict**: X`、`**Verdict: X**`、`## Verdict: X`，以及
 * 真实报告里的列表项写法 `- **Verdict: Approve** — ...`。
 */
const BODY_VERDICT_RE = /^[ \t]*(?:[-*+][ \t]+)?(?:#{1,6}[ \t]+)?[*_\s]*Verdict[*_\s]*:[ \t]*(.*)$/i;

/** verdict 值前的装饰（粗体 / 斜体 / 反引号 / 引号 / 删除线 / 空白）。 */
const VERDICT_DECORATION_RE = /^[*_`"'\s~]+/;

/**
 * `Truncated coverage:` 声明行（允许列表记号与粗体包裹）。行内散文提及
 * （如反引号包裹的 `Truncated coverage:`）不算声明，故必须行首锚定。
 */
const TRUNCATED_COVERAGE_RE = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?Truncated coverage(?:\*\*)?[ \t]*:/;

/** 空分区记号：`None.` / `- (none)` / `None — ...` / `无。`（CJK 用 ASCII 转义）。 */
const EMPTY_SECTION_RE = /^(?:\(none\)|none(?![A-Za-z])|\uff08?\u65e0\uff09?)/i;

/** 顶层条目：`- `/`* ` 或 `1.`/`1)`；缩进的续行不计入。 */
const LIST_ITEM_RE = /^(?:[-*][ \t]+|\d+[.)][ \t]+)(.*)$/;

/** `## <heading>` 二级分区（半开区间，行号不含标题行）；无该标题时 undefined。 */
function sectionRange(lines: string[], heading: string): [number, number] | undefined {
  const start = lines.findIndex((line) => {
    const m = /^(#{1,6})[ \t]+(.*?)[ \t]*$/.exec(line);
    return m !== null && m[1]!.length === 2 && m[2] === heading;
  });
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##[ \t]/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return [start + 1, end];
}

/** 正文行 —— frontmatter 围栏之后（围栏缺失时即全文）。 */
function bodyLines(lines: string[]): string[] {
  if (lines[0]?.trim() !== "---") return lines;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") return lines.slice(i + 1);
  }
  return lines;
}

/** `| a | b |` 表格行的单元格（非表格行返回 undefined）。 */
function tableCells(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return undefined;
  const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : undefined;
}

/** 文本是否以整词提到该 severity（`Warning` 命中，`Warnings` 不命中）。 */
function namesSeverity(text: string, severity: ReportSeverity): boolean {
  const index = text.indexOf(severity);
  if (index < 0) return false;
  return !/[A-Za-z]/.test(text.charAt(index - 1)) && !/[A-Za-z]/.test(text.charAt(index + severity.length));
}

/**
 * `## Summary` 各 severity 的**当前**计数 —— 最后一个命中行的最后一个数值单元格。
 * 报告只有一份状态：`## Summary` 与 `## Findings` 始终描述当前轮次，就地
 * revalidation 刷新两者，`## Revalidation` 只记录过程与逐 finding 处置、不另立
 * 计数（`qc-specialist-shared.md` § Targeted re-review）。规则 8（Summary ↔
 * Findings 对账）与规则 9（verdict ↔ 计数）因此共用这一份读数。
 * 真实报告在计数单元格里带上 finding ID 与一句话标题 —— 单元格取首个整数；
 * 计数行缺失或值非数字的 severity 视为不可判定，依赖它的规则静默。
 */
function summaryCounts(lines: string[]): Partial<Record<ReportSeverity, number>> {
  const counts: Partial<Record<ReportSeverity, number>> = {};
  const range = sectionRange(lines, "Summary");
  if (range === undefined) return counts;
  for (let i = range[0]; i < range[1]; i++) {
    const cells = tableCells(lines[i]!);
    if (cells === undefined) continue;
    const values = cells.slice(1).map((cell) => /(\d+)/.exec(cell)?.[1]);
    const tail = values.filter((digits) => digits !== undefined).pop();
    if (tail === undefined) continue;
    for (const severity of REPORT_SEVERITIES) {
      if (!namesSeverity(cells[0]!, severity)) continue;
      counts[severity] = Number(tail);
    }
  }
  return counts;
}

/**
 * `## Findings` 各 severity 分区的顶层条目数：`None.` / `(none)` / `无。` 记 0，
 * 缩进续行（`  - Verification:`）不计数。没有对应分区的 severity 不入表
 * （不可判定，规则 8 静默）。
 */
function findingsCounts(lines: string[]): Partial<Record<ReportSeverity, number>> {
  const counts: Partial<Record<ReportSeverity, number>> = {};
  const range = sectionRange(lines, "Findings");
  if (range === undefined) return counts;
  let current: ReportSeverity | undefined;
  for (let i = range[0]; i < range[1]; i++) {
    const line = lines[i]!;
    const heading = /^###[ \t]+(.*?)[ \t]*$/.exec(line);
    if (heading !== null) {
      current = REPORT_SEVERITIES.find((severity) => namesSeverity(heading[1]!, severity));
      if (current !== undefined && counts[current] === undefined) counts[current] = 0;
      continue;
    }
    if (current === undefined) continue;
    const item = LIST_ITEM_RE.exec(line);
    if (item === null || EMPTY_SECTION_RE.test(item[1]!.trim())) continue;
    counts[current] = (counts[current] ?? 0) + 1;
  }
  return counts;
}

/**
 * 正文 verdict 行的取词：去掉装饰后按 `QC_VERDICTS` **最长前缀**匹配，且
 * 后随字符必须非字母数字 —— 多词 verdict（`Request Changes` /
 * `Needs Discussion`）与历史写法（`Approve with residuals` → `Approve`）因此都能
 * 取到词表成员。不在词表内时返回首个空白分隔 token，供调用方报出冒犯值。
 *
 * **最后一个 verdict 行生效**：席位在 targeted re-review 中就地把最终
 * `**Verdict**:` 行写在原轮 verdict 之后（frontmatter 同步更新为新 verdict），
 * 因此 `Request Changes` → `Approve` 的 revalidation 报告不会被原轮行误判；
 * 单 verdict 行的报告取值不变。
 */
function bodyVerdictPhrase(lines: string[]): string | undefined {
  let phrase: string | undefined;
  for (const line of bodyLines(lines)) {
    const m = BODY_VERDICT_RE.exec(line);
    if (m === null) continue;
    const text = m[1]!.trim().replace(VERDICT_DECORATION_RE, "");
    phrase = text.split(/\s+/)[0] ?? "";
    for (const verdict of [...QC_VERDICTS].sort((a, b) => b.length - a.length)) {
      if (!text.startsWith(verdict)) continue;
      const next = text.charAt(verdict.length);
      if (next === "" || !/[A-Za-z0-9]/.test(next)) {
        phrase = verdict;
        break;
      }
    }
  }
  return phrase;
}

function violation(severity: Severity, code: string, message: string, fix: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

/**
 * Validate a QC 席位报告 against the rules in the module header.
 * Structural checks only — 报告形状与 frontmatter 一致性，不重审审查内容。
 */
export function validateQcReport(text: string): GateResult {
  const violations: ValidationResult[] = [];
  if (lines_missing_fence(text)) {
    return {
      ok: false,
      violations: [
        violation(
          "high",
          "qcreview.report.missing-frontmatter",
          "no `---` fenced frontmatter found - a QC seat report must open with the machine-readable frontmatter block (report-template.md \u00a7 Frontmatter)",
          "open the report with `---` and the fields `report_kind: qc` / `reviewer` / `reviewer_index` / `plan_id` / `verdict` / `generated_at`",
        ),
      ],
    };
  }

  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const { doc } = parseReportFrontmatter(text);

  for (const field of REPORT_FIELDS) {
    const value = doc[field];
    if (value === undefined || value.trim() === "") {
      violations.push(
        violation(
          "medium",
          `qcreview.report.missing-${field}`,
          `missing required frontmatter field: ${field}`,
          `add "${field}: <value>" to the frontmatter block (report-template.md \u00a7 Frontmatter)`,
        ),
      );
    }
  }

  const reportKind = doc.report_kind?.trim() ?? "";
  if (reportKind !== "" && reportKind !== "qc") {
    violations.push(
      violation(
        "medium",
        "qcreview.report.invalid-report-kind",
        `report_kind "${reportKind}" is not "qc"`,
        'use `report_kind: qc` for a QC seat report (a PM consolidated report is not a seat report)',
      ),
    );
  }

  const frontmatterVerdict = doc.verdict?.trim() ?? "";
  const frontmatterVerdictIsValid = (QC_VERDICTS as readonly string[]).includes(frontmatterVerdict);
  if (frontmatterVerdict !== "" && !frontmatterVerdictIsValid) {
    violations.push(
      violation(
        "medium",
        "qcreview.report.invalid-verdict",
        `frontmatter verdict "${frontmatterVerdict}" is not one of ${JSON.stringify(QC_VERDICTS)}`,
        `use one of: ${QC_VERDICTS.join(" | ")} - the vocabulary is verbatim (report-template.md \u00a7 Report body template)`,
      ),
    );
  }

  const generatedAt = doc.generated_at?.trim() ?? "";
  if (generatedAt !== "" && !REPORT_DATE_RE.test(generatedAt)) {
    violations.push(
      violation(
        "medium",
        "qcreview.report.invalid-generated-at",
        `generated_at "${generatedAt}" must be a calendar date (YYYY-MM-DD)`,
        'write `generated_at: "YYYY-MM-DD"` (report-template.md \u00a7 Frontmatter)',
      ),
    );
  }

  const bodyPhrase = bodyVerdictPhrase(lines);
  const bodyPhraseIsValid = bodyPhrase !== undefined && (QC_VERDICTS as readonly string[]).includes(bodyPhrase);
  if (bodyPhrase === undefined) {
    violations.push(
      violation(
        "high",
        "qcreview.report.missing-body-verdict",
        "the report body carries no verdict line (`**Verdict**: <verdict>` or `## Verdict: <verdict>`)",
        `add a body verdict line using one of: ${QC_VERDICTS.join(" | ")}`,
      ),
    );
  } else if (!bodyPhraseIsValid) {
    violations.push(
      violation(
        "high",
        "qcreview.report.verdict-mismatch",
        bodyPhrase === ""
          ? `the body verdict line is empty - expected one of ${JSON.stringify(QC_VERDICTS)}`
          : `body verdict "${bodyPhrase}" is not one of ${JSON.stringify(QC_VERDICTS)}`,
        `start the verdict line with one of: ${QC_VERDICTS.join(" | ")}`,
      ),
    );
  } else if (frontmatterVerdictIsValid && bodyPhrase !== frontmatterVerdict) {
    violations.push(
      violation(
        "high",
        "qcreview.report.verdict-mismatch",
        `body verdict "${bodyPhrase}" does not match the frontmatter verdict "${frontmatterVerdict}"`,
        "make the frontmatter verdict and the body verdict line agree on the same final verdict",
      ),
    );
  }

  const summary = summaryCounts(lines);
  const findings = findingsCounts(lines);
  for (const severity of REPORT_SEVERITIES) {
    const claimed = summary[severity];
    const counted = findings[severity];
    if (claimed === undefined || counted === undefined || claimed === counted) continue;
    violations.push(
      violation(
        "high",
        "qcreview.report.summary-count-mismatch",
        `## Summary ${severity} count ${claimed} does not match the ${counted} top-level entr${counted === 1 ? "y" : "ies"} under ## Findings (\u00a7 ${severity})`,
        `recount \u00a7 ${severity} and update the ## Summary row - one top-level entry per finding, detail lines indented (report-template.md \u00a7 Findings)`,
      ),
    );
  }

  const effectiveVerdict = frontmatterVerdictIsValid
    ? frontmatterVerdict
    : bodyPhraseIsValid
      ? bodyPhrase
      : undefined;
  if (effectiveVerdict !== undefined) {
    // 规则 9 与规则 8 同源：`## Summary` 是报告唯一的当前计数（revalidation
    // 就地刷新它），裁决因此基于席位自己声明的当前状态。
    const critical = summary.Critical;
    const warning = summary.Warning;
    const blocking = (critical ?? 0) + (warning ?? 0);
    if (effectiveVerdict === "Approve" && blocking > 0) {
      violations.push(
        violation(
          "high",
          "qcreview.report.verdict-contradicts-counts",
          `verdict "Approve" with ${blocking} Critical/Warning finding(s) in ## Summary (Critical ${critical ?? 0}, Warning ${warning ?? 0})`,
          'do not Approve with open Critical/Warning findings - close them or use "Request Changes" / "Needs Discussion"',
        ),
      );
    }
    const unconfirmed = summary.Unconfirmed;
    if (unconfirmed !== undefined && unconfirmed > 0 && effectiveVerdict !== "Unconfirmed") {
      violations.push(
        violation(
          "high",
          "qcreview.report.verdict-contradicts-counts",
          `verdict "${effectiveVerdict}" with ${unconfirmed} Unconfirmed finding(s) in ## Summary - a failed evidence channel transmits as "Unconfirmed" (mstar-review-qc \u00a7 \u5e2d\u4f4d\u9884\u7b97\u4e0e\u622a\u65ad)`,
          'set the verdict to "Unconfirmed" or re-establish the evidence channel before converging',
        ),
      );
    }
    if (effectiveVerdict === "Unconfirmed" && lines.some((line) => TRUNCATED_COVERAGE_RE.test(line))) {
      violations.push(
        violation(
          "high",
          "qcreview.report.truncation-verdict",
          'the report declares `Truncated coverage:` but carries the verdict "Unconfirmed" - a budget/scope cut is not a failed evidence channel',
          'keep the verdict earned for the reviewed scope and reserve "Unconfirmed" for a failed evidence channel',
        ),
      );
    }
  }

  return { ok: violations.length === 0, violations };
}
