/** Coordinator-visible Phase-2 diagnostic notice (the shared visible bar title). */
export const PHASE2_NOTICE_CUSTOM_TYPE = "mstar:notice";
/** Coordinator-visible model-handoff notice (the same shared visible bar title). */
export const HANDOFF_NOTICE_CUSTOM_TYPE = "mstar:notice";

export type NoticeTitle = Readonly<{ title: string; detail: string }>;

/** Title states the workflow and its actual status. */
export function statusNotice(input: {
  workflowId: string;
  status: string;
  detail: string;
}): NoticeTitle {
  return {
    title: `Workflow ${input.workflowId} is ${input.status}`,
    detail: input.detail,
  };
}

/** Title states what the seat observed, never what the workflow's status is. */
export function fallbackNotice(input: { subject: string; detail: string }): NoticeTitle {
  return {
    title: `${input.subject} needs attention`,
    detail: input.detail,
  };
}

/**
 * `${title}: ${detail}` — the single rendering point. A detail that opens with
 * the title's own sentence (the status-bearing case whose observed condition is
 * that same sentence) states it once: the title is kept and the detail's
 * remainder follows it.
 */
export function formatNotice(notice: NoticeTitle): string {
  const rest = notice.detail.slice(notice.title.length);
  if (rest !== "" && notice.detail.slice(0, notice.title.length).toLowerCase() === notice.title.toLowerCase()) {
    return `${notice.title}${rest}`;
  }
  return `${notice.title}: ${notice.detail}`;
}
