/**
 * Native OpenCode V2 entry point (`@opencode/plugin@2.0.26`, pinned by the
 * package manifest). The installed declarations resolve the effect API as:
 * - `dist/effect/index.d.ts:1`: `Plugin` namespace export;
 * - `dist/effect/plugin.d.ts:54-58`: `Plugin` has `id` and `effect`, and
 *   `Plugin.define(plugin)` is the constructor;
 * - `dist/effect/agent.d.ts:5-14`: `ctx.agent.transform(editor => ...)`, with
 *   `AgentEditor.update(id, fn)` as its upsert operation;
 * - `dist/effect/command.d.ts:12-22`: `ctx.command.transform(editor => ...)`,
 *   with `CommandEditor.add(definition)`;
 * - `dist/effect/skill.d.ts:5-14`: `ctx.skill.transform(editor => ...)`, with
 *   `SkillEditor.add(info)`.
 * The tag cross-check is
 * https://github.com/anomalyco/opencode/blob/v2.0.26/packages/plugin/src/effect/plugin.ts.
 * These editor transform calls are the exact 2.0.26 registration surface.
 */
import fs from "node:fs";
import { Plugin as NativePlugin, Skill } from "@opencode/plugin/effect";
import type { Context } from "@opencode/plugin/effect/plugin";
import { Effect } from "effect";
import type * as Scope from "effect/Scope";

import {
  loadBundledAgents,
  loadBundledCommands,
  loadBundledSkills,
  projectAgentDefinition,
} from "./assets";
import type { CommandDefinition as AssetCommandDefinition, SkillEntry } from "./assets";
import { defaultStatusLogger } from "./log";
import { registerDispatchGate, registerHooks } from "./hooks/mod";

const PLUGIN_ID = "morning-star-harness";

type BundledAssets = {
  agents: Record<string, Record<string, unknown>>;
  commands: Record<string, AssetCommandDefinition>;
  skills: SkillEntry[];
  skillContent: Record<string, string>;
};

/** Register a preloaded immutable asset snapshot. Editor callbacks only mutate
 * their in-memory registrations; all package files were read before they run. */
export function registerAssets(context: Context, assets: BundledAssets): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    yield* context.agent.transform((editor) => {
      for (const [roleId, raw] of Object.entries(assets.agents)) {
        const bundled = projectAgentDefinition(raw);
        editor.update(roleId, (current) => {
          Object.assign(current, bundled);
        });
      }
    });

    yield* context.command.transform((editor) => {
      for (const [name, command] of Object.entries(assets.commands)) {
        editor.add({
          name,
          ...(command.description === undefined ? {} : { description: command.description }),
          execute: (input) =>
            Effect.asVoid(context.session.prompt({
              sessionID: input.sessionID,
              text: [command.template, input.prompt.text].filter(Boolean).join("\n\n"),
              files: input.prompt.files,
              agents: input.prompt.agents,
              skills: input.prompt.skills,
              delivery: input.delivery,
            })),
        });
      }
    });

    yield* context.skill.transform((editor) => {
      for (const skill of assets.skills) {
        editor.add({
          id: skill.name as Skill.ID,
          name: skill.name as Skill.Name,
          path: skill.location as Skill.Info["path"],
          content: assets.skillContent[skill.name] ?? "",
        });
      }
    });
  });
}

const plugin = NativePlugin.define({
  id: PLUGIN_ID,
  effect: (context: Context) => {
    const agents = loadBundledAgents();
    const commands = loadBundledCommands();
    const skills = loadBundledSkills();
    const skillContent = Object.fromEntries(
      skills.map((skill) => [skill.name, fs.readFileSync(skill.location, "utf8")]),
    );
    defaultStatusLogger(
      "info",
      `registering ${Object.keys(agents).length} agents, ${Object.keys(commands).length} commands, and ${skills.length} skills`,
    );
    return Effect.gen(function* () {
      yield* registerAssets(context, { agents, commands, skills, skillContent });
      yield* registerHooks(context);
      yield* registerDispatchGate(context);
    });
  },
});

export default plugin;
