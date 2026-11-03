/**
 * `SyncBinding` — the binding view's screen.
 *
 * The load-bearing assertions:
 *
 *  - the identity block renders the `.mstarc` summary it was handed, and a null
 *    binding renders the reader's refusal verbatim — never a readiness state;
 *  - the stored correspondence renders one row per binding, and no rows render
 *    the explicit `empty` arm rather than an empty table;
 *  - every readiness state renders with the cause the DTO carried, including
 *    `not-probed`, whose cause is the point of keeping it distinct from a null
 *    binding;
 *  - no issue row, no failure count and no credential field reaches the screen;
 *  - both locales supply every string (the types hold the key set; this renders
 *    each one through the real screen).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SyncBindingDTO } from "@mstar-harness/engine";

import { en, zh, type Copy } from "../locale/index.ts";
import { syncBindingModel } from "../view-model/sync-binding.ts";
import { SyncBinding, type SyncBindingCopy } from "./SyncBinding.tsx";

/**
 * The dictionary section IS the screen's copy; the four absence families are the
 * shared vocabulary, borrowed the way `coverage.test.ts` does it for every screen.
 * The return type is the compile-time half of "no key is missing in either
 * language": a key the screen asks for and a locale lacks fails `tsc`.
 */
const copyOf = (copy: Copy): SyncBindingCopy => ({ ...copy.syncBinding, state: copy.state });

const BOUND: NonNullable<SyncBindingDTO["binding"]> = { enabled: true, mode: "mirror", workspace: "acme", team: "ENG" };

function dto(over: Partial<SyncBindingDTO> = {}): SyncBindingDTO {
  return {
    binding: BOUND,
    bindingError: null,
    projectBindings: [
      { projectId: "_default", remoteProject: "MST-BACKLOG" },
      { projectId: "engine", remoteProject: "MST-ENGINE" },
    ],
    projectBindingsError: null,
    readiness: { state: "ready", cause: "ready: linear-mcp answered initialize and tools/list" },
    ...over,
  };
}

const render = (data: SyncBindingDTO, copy: Copy = en): string =>
  renderToStaticMarkup(<SyncBinding model={syncBindingModel(data)} copy={copyOf(copy)} />);

test("identity: the workspace, team and mode the .mstarc summary names", () => {
  const html = render(dto());
  expect(html).toContain("acme");
  expect(html).toContain("ENG");
  expect(html).toContain("mirror");
  expect(html).toContain(en.syncBinding.identityHeading);
});

test("identity: a null binding renders the reader's refusal verbatim", () => {
  const message = "linear.binding-absent: .mstarc declares no [linear] section";
  const html = render(dto({ binding: null, bindingError: message }));
  expect(html).toContain(message);
  expect(html).toContain(en.syncBinding.bindingErrorLabel);
  // The identity fields are replaced, not left behind as empty rows.
  expect(html).not.toContain(en.syncBinding.fields.workspace);
});

test("identity: a refusal that arrived without a message renders the dictionary's own sentence", () => {
  // The DTO pairs a null binding with `bindingError`; a transport that drops the
  // message leaves the wording to the copy, so each locale supplies its own.
  for (const copy of [en, zh]) {
    const html = render(dto({ binding: null, bindingError: null }), copy);
    expect(html).toContain(copy.syncBinding.bindingAbsent);
    expect(html).toContain(copy.syncBinding.bindingErrorLabel);
  }
});

test("correspondence: one row per stored binding, verbatim", () => {
  const html = render(dto());
  for (const cell of ["_default", "MST-BACKLOG", "engine", "MST-ENGINE"]) expect(html).toContain(cell);
  expect(html).toContain("data-ms-table");
});

test("correspondence: no rows renders the explicit empty arm, not an empty table", () => {
  const html = render(dto({ projectBindings: [] }));
  expect(html).toContain('data-ms-absence="empty"');
  expect(html).toContain(en.state.empty.body);
  expect(html).toContain(en.syncBinding.correspondenceHeading);
  expect(html).not.toContain("data-ms-table");
});

test("correspondence: a failed read renders the unavailable arm with the read's reason", () => {
  const reason = "sync-binding.correspondence-unreadable: no such table: project_bindings";
  const html = render(dto({ projectBindings: [], projectBindingsError: reason }));
  // The regression: an empty array rendered as `empty` before the failure rode
  // beside it, so a real SQL failure told the reader the store held nothing.
  expect(html).toContain('data-ms-absence="unavailable"');
  expect(html).toContain(en.state.unavailable.body);
  expect(html).toContain(reason);
  expect(html).not.toContain(en.state.empty.body);
});

test("an empty correspondence is not a null binding: both facts render together", () => {
  const message = "linear.binding-absent: .mstarc declares no [linear] section";
  const html = render(dto({ binding: null, bindingError: message, projectBindings: [] }));
  expect(html).toContain(message);
  expect(html).toContain('data-ms-absence="empty"');
});

test("readiness: each state renders with its own cause and tone", () => {
  const pairs = [
    ["ready", "ready: linear-mcp answered initialize and tools/list", "success"],
    ["service-absent", "service-absent: the host declares no linear-mcp entry", "warning"],
    ["unreachable", "unreachable: the handshake did not answer within the probe deadline", "warning"],
    ["access-denied", "access-denied: the credential was rejected or has expired", "danger"],
    ["not-probed", "not-probed: readiness is host-owned; no probe result was supplied", "neutral"],
  ] as const;
  for (const [state, cause, tone] of pairs) {
    const html = render(dto({ readiness: { state, cause } }));
    expect(html).toContain(cause);
    expect(html).toContain(`tone-${tone}`);
    expect(html).toContain(`data-ms-tone="${tone}"`);
  }
});

test("readiness: a state with no cause renders the refusal, not a bare label", () => {
  const html = render(dto({ readiness: { state: "ready", cause: "   " } }));
  expect(html).toContain("readiness.ready carries no cause");
  expect(html).not.toContain("tone-success");
});

test("no issue row, failure count or credential field reaches the screen", () => {
  const html = render(dto());
  expect(html).not.toMatch(/token|secret|credential/i);
  expect(html).not.toMatch(/I-\d{6}/);
  expect(html).not.toContain("data-ms-issue");
  expect(html).not.toMatch(/failures?\s*[:=]/i);
});

test("both locales supply every string the screen renders", () => {
  for (const copy of [en, zh]) {
    const html = render(dto(), copy);
    for (const value of [
      copy.syncBinding.pageTitle,
      copy.syncBinding.subtitle,
      copy.syncBinding.identityHeading,
      copy.syncBinding.identityNote,
      copy.syncBinding.readinessHeading,
      copy.syncBinding.stateLabel,
      copy.syncBinding.causeLabel,
      copy.syncBinding.readinessNote,
      copy.syncBinding.correspondenceHeading,
      copy.syncBinding.fields.workspace,
      copy.syncBinding.bindingsCount(2),
    ]) {
      expect(value.trim()).not.toBe("");
      expect(html).toContain(value);
    }
    // The foot note carries an apostrophe, which static markup escapes; its own
    // identifier fragment is the part that proves the note rendered.
    expect(copy.syncBinding.correspondenceNote).toContain("project_bindings");
    expect(html).toContain("project_bindings");
  }
});
