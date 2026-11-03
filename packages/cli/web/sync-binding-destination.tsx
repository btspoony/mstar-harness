/**
 * The binding destination: the route that mounts it, the read behind it, and the
 * screen that paints the read's answer.
 *
 * Split into a loader and a screen so the render half is a plain function of a
 * settled read. The browser gate (`test/render-gate.test.ts`) checks the mount in
 * a real page; the split is what lets ordinary CI assert the same chain without
 * one — route → destination → rendered read result.
 */
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { EmptyState, SyncBinding, useCopy, type Copy } from "@mstar-harness/ui";

import type { Route } from "./route";
import {
  readSyncBinding,
  syncBindingCopy,
  syncBindingOutcome,
  type SyncBindingOutcome,
} from "./sync-binding-data";

/**
 * The screen for one settled read.
 *
 * `loading` is a transport phase, not a subject state: it paints no arm and
 * claims nothing. A refused read paints the shared unavailable family with its
 * own reason; a ready one paints the panel's three answers.
 */
export function SyncBindingScreen(props: { outcome: SyncBindingOutcome; copy: Copy }): ReactElement | null {
  const { outcome, copy } = props;
  if (outcome.kind === "loading") return null;
  if (outcome.kind === "failed") {
    return (
      <EmptyState
        arm="unavailable"
        labelWord={copy.state.unavailable.labelWord}
        heading={copy.syncBinding.pageTitle}
        body={copy.state.unavailable.body}
        reason={outcome.message}
      />
    );
  }
  return <SyncBinding model={outcome.model} copy={syncBindingCopy(copy)} />;
}

/**
 * The binding view, behind its own read.
 *
 * The dashboard is the host and has no Linear probe result to attach, so it sends
 * no `probe_state`: readiness arrives as `not-probed` with the cause the engine
 * sets. Composing a probe here would make the panel claim an observation nobody
 * made — the one thing it refuses to do.
 */
export function SyncBindingDestination(): ReactElement | null {
  const [outcome, setOutcome] = useState<SyncBindingOutcome>({ kind: "loading" });
  const copy = useCopy();
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    void readSyncBinding(fetch, controller.signal).then((result) => {
      if (current) setOutcome(syncBindingOutcome(result));
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, []);

  return <SyncBindingScreen outcome={outcome} copy={copy} />;
}

/** The destination the shell mounts for one route; `null` for every other route. */
export function syncBindingDestination(route: Route): ReactElement | null {
  return route.name === "sync-binding" ? <SyncBindingDestination /> : null;
}
