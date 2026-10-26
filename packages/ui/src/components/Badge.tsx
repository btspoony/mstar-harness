/**
 * An enum-ish marker: a catalog lifecycle word, an issue kind, a project id.
 *
 * Mono and small, because a badge sits inside dense rows and must never grow a
 * row (`DESIGN.md` § Spacing). It is decorative in the sense that the text is
 * the fact; the tone only softens how loud it reads.
 */
import type { ReactNode } from "react";

import type { Tone } from "../view-model/status.ts";
import css from "./Badge.module.css";

export type BadgeProps = {
  children: ReactNode;
  /** Only `danger` and `warning` are used today: a badge never celebrates. */
  tone?: Extract<Tone, "danger" | "warning" | "neutral">;
};

export function Badge(props: BadgeProps) {
  return (
    <span className="badge" data-ms-badge-tone={props.tone ?? "neutral"}>
      {props.children}
    </span>
  );
}
