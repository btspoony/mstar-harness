/** Durable Phase-2 diagnostic notice (unchanged literal). */
export const PHASE2_NOTICE_CUSTOM_TYPE = "mstar:phase2-notice";
/** Durable model-handoff notice (unchanged literal). */
export const HANDOFF_NOTICE_CUSTOM_TYPE = "mstar:model-handoff-notice";

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

/** `${title}: ${detail}` — the single rendering point. */
export function formatNotice(notice: NoticeTitle): string {
  return `${notice.title}: ${notice.detail}`;
}
