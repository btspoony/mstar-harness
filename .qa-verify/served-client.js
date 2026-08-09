window.__ModuleLoader__.load({ id: "@mstar-harness/dsh", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __moduleCache = /* @__PURE__ */ new WeakMap;
var __toCommonJS = (from) => {
  var entry = __moduleCache.get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function")
    __getOwnPropNames(from).map((key) => !__hasOwnProp.call(entry, key) && __defProp(entry, key, {
      get: () => from[key],
      enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
    }));
  __moduleCache.set(from, entry);
  return entry;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};

// src/client/index.ts
var exports_client = {};
__export(exports_client, {
  inject: () => inject,
  apply: () => apply
});
module.exports = __toCommonJS(exports_client);

// src/client/panel/locale.ts
var NS = "mstar-panel";
var zh = {
  "view.mstar-workflow": "工作流",
  "empty.waiting": "等待首条 engine-status catalog…",
  "empty.no-harness": "未检测到 Morning Star harness",
  "watermark.version": "mstar {version}",
  "watermark.harness": "harness: {dir}",
  "watermark.enforcement": "enforcement: {value}",
  "watermark.hard": "hard",
  "watermark.soft": "soft",
  "watermark.none": "无",
  "panel.unknown": "未知",
  "iteration.title": "迭代",
  "iteration.id": "id",
  "iteration.transition": "transition",
  "iteration.plans-done": "all plans done",
  "iteration.gate": "gate",
  "iteration.pass": "PASS",
  "iteration.fail": "FAIL",
  "iteration.entry": "entry",
  "iteration.exit": "exit",
  "iteration.status-path": "status",
  "iteration.compass-path": "compass",
  "iteration.violations": "违规 ({count})",
  "iteration.no-violations": "无违规",
  "iteration.no-compass": "无 steering compass / status.json",
  "state.title": "工作区状态",
  "state.plans": "计划",
  "state.residuals": "未决残留",
  "state.branches": "分支",
  "state.policy": "策略",
  "state.leases": "租约",
  "state.knowledge": "知识",
  "state.direction": "方向",
  "state.none": "无",
  "state.branch.iteration-base": "iteration base",
  "state.branch.target": "target",
  "state.branch.spec-integration": "spec integration",
  "state.policy.push": "push",
  "state.policy.worktree": "worktree",
  "state.policy.control-worktree": "control worktree",
  "state.knowledge.docs": "{count} 篇文档",
  "freshness.last-updated": "最后更新 {time}",
  "freshness.refresh-note": "刷新跟随 catalog 重发（约 ≤1 分钟）"
};
var en = {
  "view.mstar-workflow": "Workflow",
  "empty.waiting": "Waiting for the first engine-status catalog…",
  "empty.no-harness": "No Morning Star harness detected",
  "watermark.version": "mstar {version}",
  "watermark.harness": "harness: {dir}",
  "watermark.enforcement": "enforcement: {value}",
  "watermark.hard": "hard",
  "watermark.soft": "soft",
  "watermark.none": "none",
  "panel.unknown": "unknown",
  "iteration.title": "Iteration",
  "iteration.id": "id",
  "iteration.transition": "transition",
  "iteration.plans-done": "all plans done",
  "iteration.gate": "gate",
  "iteration.pass": "PASS",
  "iteration.fail": "FAIL",
  "iteration.entry": "entry",
  "iteration.exit": "exit",
  "iteration.status-path": "status",
  "iteration.compass-path": "compass",
  "iteration.violations": "violations ({count})",
  "iteration.no-violations": "no violations",
  "iteration.no-compass": "No steering compass / status.json",
  "state.title": "Workspace state",
  "state.plans": "Plans",
  "state.residuals": "Open residuals",
  "state.branches": "Branches",
  "state.policy": "Policy",
  "state.leases": "Leases",
  "state.knowledge": "Knowledge",
  "state.direction": "Direction",
  "state.none": "none",
  "state.branch.iteration-base": "iteration base",
  "state.branch.target": "target",
  "state.branch.spec-integration": "spec integration",
  "state.policy.push": "push",
  "state.policy.worktree": "worktree",
  "state.policy.control-worktree": "control worktree",
  "state.knowledge.docs": "{count} docs",
  "freshness.last-updated": "last updated {time}",
  "freshness.refresh-note": "refreshes with catalog re-emission (≤~1 min)"
};

// src/client/panel/panel.module.css
var css = `

.20fd0e45_root {
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 16px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  font: var(--dsw-font-xs-13);
  line-height: 1.5;
}

.86777a51_watermark {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  color: var(--dsw-alias-label-caption);
  font: var(--dsw-font-xxxs-11);
  letter-spacing: 0.02em;
}

.fcdd0ccc_section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}

.aded23ea_sectionTitle {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.b7190159_subTitle {
  margin: 4px 0 0;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
  font-weight: 500;
}

.26763614_defList {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 2px 12px;
  margin: 0;
}

.670df156_defTerm {
  color: var(--dsw-alias-label-caption);
}

.3f1b3a05_defValue {
  margin: 0;
  overflow-wrap: anywhere;
}

.a129f16e_planList,
.113e0aa2_residualList,
.33dfcc85_leaseList,
.999efdc0_violationList {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.744bf63f_planId,
.560663a6_leasePlan,
.a68a6d03_leaseHolder,
.db027b44_leaseWorktree,
.c04587c1_residualSeverity,
.628ed625_residualCount,
.e42c0bfd_violationCode,
.e2098247_knowledgeCategories {
  display: inline-block;
}

.a3021d7c_planStatus {
  display: inline-block;
  margin-right: 8px;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxxs-11);
}

.a3021d7c_planStatus[data-status='Done'] {
  border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
}

.a3021d7c_planStatus[data-status='InProgress'] {
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-state-business-primary);
}

.e42c0bfd_violationCode {
  margin-right: 8px;
  color: var(--dsw-alias-state-warn-label);
}

.999efdc0_violationList [data-severity='critical'],
.999efdc0_violationList [data-severity='high'] {
  color: var(--dsw-alias-state-error-primary);
}

.db027b44_leaseWorktree {
  margin-left: 8px;
  color: var(--dsw-alias-label-caption);
}

.3eb5feeb_knowledge {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin: 0;
}

.e2098247_knowledgeCategories {
  color: var(--dsw-alias-label-caption);
}

.df6dc76a_direction {
  margin: 0;
  overflow-wrap: anywhere;
}

.18a7beee_empty {
  margin: 0;
  color: var(--dsw-alias-label-caption);
}

.c75c59b0_freshness {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-caption);
  font: var(--dsw-font-xxxs-11);
}
`;
var tagId = "@mstar-harness/dsh/panel.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@mstar-harness/dsh";
  tag.dataset.pluginCss = tagId;
  tag.textContent = css;
  document.head.appendChild(tag);
}
var panel_module_default = { root: "20fd0e45_root", watermark: "86777a51_watermark", section: "fcdd0ccc_section", sectionTitle: "aded23ea_sectionTitle", subTitle: "b7190159_subTitle", defList: "26763614_defList", defTerm: "670df156_defTerm", defValue: "3f1b3a05_defValue", planList: "a129f16e_planList", residualList: "113e0aa2_residualList", leaseList: "33dfcc85_leaseList", violationList: "999efdc0_violationList", planId: "744bf63f_planId", leasePlan: "560663a6_leasePlan", leaseHolder: "a68a6d03_leaseHolder", leaseWorktree: "db027b44_leaseWorktree", residualSeverity: "c04587c1_residualSeverity", residualCount: "628ed625_residualCount", violationCode: "e42c0bfd_violationCode", knowledgeCategories: "e2098247_knowledgeCategories", planStatus: "a3021d7c_planStatus", knowledge: "3eb5feeb_knowledge", direction: "df6dc76a_direction", empty: "18a7beee_empty", freshness: "c75c59b0_freshness" };

// src/client/panel/guards.ts
function str(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function bool(value) {
  return typeof value === "boolean" ? value : null;
}
function count(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// src/client/panel/iteration-section.tsx
var jsx_runtime = require("react/jsx-runtime");
function phaseVerdict(t, phase) {
  const ok = bool(phase?.ok);
  if (ok === null)
    return t("panel.unknown");
  if (ok)
    return t("iteration.pass");
  const violations = Array.isArray(phase?.violations) ? phase.violations : [];
  return `${t("iteration.fail")} (${violations.length})`;
}
function IterationSection({ t, iteration }) {
  if (iteration == null)
    return null;
  const gate = iteration.gate;
  const violations = Array.isArray(gate?.violations) ? gate.violations : [];
  const verdict = bool(gate?.ok) === null ? t("panel.unknown") : gate?.ok ? t("iteration.pass") : t("iteration.fail");
  return /* @__PURE__ */ jsx_runtime.jsxs("section", {
    className: panel_module_default.section,
    "data-mstar-section": "iteration",
    children: [
      /* @__PURE__ */ jsx_runtime.jsx("h2", {
        className: panel_module_default.sectionTitle,
        children: t("iteration.title")
      }),
      /* @__PURE__ */ jsx_runtime.jsxs("dl", {
        className: panel_module_default.defList,
        children: [
          /* @__PURE__ */ jsx_runtime.jsx("dt", {
            className: panel_module_default.defTerm,
            children: t("iteration.id")
          }),
          /* @__PURE__ */ jsx_runtime.jsx("dd", {
            className: panel_module_default.defValue,
            children: str(iteration.iterationId) ?? t("panel.unknown")
          }),
          /* @__PURE__ */ jsx_runtime.jsx("dt", {
            className: panel_module_default.defTerm,
            children: t("iteration.transition")
          }),
          /* @__PURE__ */ jsx_runtime.jsx("dd", {
            className: panel_module_default.defValue,
            "data-field": "transition",
            children: str(gate?.transition) ?? t("panel.unknown")
          }),
          /* @__PURE__ */ jsx_runtime.jsx("dt", {
            className: panel_module_default.defTerm,
            children: t("iteration.plans-done")
          }),
          /* @__PURE__ */ jsx_runtime.jsx("dd", {
            className: panel_module_default.defValue,
            "data-field": "all-plans-done",
            children: bool(gate?.all_plans_done) === null ? t("panel.unknown") : String(gate?.all_plans_done)
          }),
          /* @__PURE__ */ jsx_runtime.jsx("dt", {
            className: panel_module_default.defTerm,
            children: t("iteration.gate")
          }),
          /* @__PURE__ */ jsx_runtime.jsx("dd", {
            className: panel_module_default.defValue,
            "data-gate-verdict": verdict,
            children: verdict
          }),
          /* @__PURE__ */ jsx_runtime.jsx("dt", {
            className: panel_module_default.defTerm,
            children: t("iteration.entry")
          }),
          /* @__PURE__ */ jsx_runtime.jsx("dd", {
            className: panel_module_default.defValue,
            "data-gate-phase": "entry",
            children: phaseVerdict(t, gate?.entry)
          }),
          /* @__PURE__ */ jsx_runtime.jsx("dt", {
            className: panel_module_default.defTerm,
            children: t("iteration.exit")
          }),
          /* @__PURE__ */ jsx_runtime.jsx("dd", {
            className: panel_module_default.defValue,
            "data-gate-phase": "exit",
            children: phaseVerdict(t, gate?.exit)
          }),
          /* @__PURE__ */ jsx_runtime.jsx("dt", {
            className: panel_module_default.defTerm,
            children: t("iteration.status-path")
          }),
          /* @__PURE__ */ jsx_runtime.jsx("dd", {
            className: panel_module_default.defValue,
            "data-field": "status-path",
            children: str(iteration.statusPath) ?? t("panel.unknown")
          }),
          /* @__PURE__ */ jsx_runtime.jsx("dt", {
            className: panel_module_default.defTerm,
            children: t("iteration.compass-path")
          }),
          /* @__PURE__ */ jsx_runtime.jsx("dd", {
            className: panel_module_default.defValue,
            "data-field": "compass-path",
            children: str(iteration.compassPath) ?? t("panel.unknown")
          })
        ]
      }),
      /* @__PURE__ */ jsx_runtime.jsx("h3", {
        className: panel_module_default.subTitle,
        children: t("iteration.violations", { count: String(violations.length) })
      }),
      violations.length === 0 ? /* @__PURE__ */ jsx_runtime.jsx("p", {
        className: panel_module_default.empty,
        "data-mstar-empty": "no-violations",
        children: t("iteration.no-violations")
      }) : /* @__PURE__ */ jsx_runtime.jsx("ul", {
        className: panel_module_default.violationList,
        children: violations.map((violation, i) => /* @__PURE__ */ jsx_runtime.jsxs("li", {
          "data-violation-code": str(violation.code) ?? "unknown",
          "data-severity": str(violation.severity) ?? "unknown",
          children: [
            /* @__PURE__ */ jsx_runtime.jsx("code", {
              className: panel_module_default.violationCode,
              children: str(violation.code) ?? t("panel.unknown")
            }),
            /* @__PURE__ */ jsx_runtime.jsx("span", {
              className: panel_module_default.violationMessage,
              children: str(violation.message) ?? ""
            })
          ]
        }, str(violation.code) ?? `violation-${i}`))
      })
    ]
  });
}

// src/client/panel/state-section.tsx
var jsx_runtime2 = require("react/jsx-runtime");
function StateSection({ t, state }) {
  const plans = Array.isArray(state?.plans) ? state.plans : [];
  const residuals = Array.isArray(state?.residuals) ? state.residuals : [];
  const leases = Array.isArray(state?.leases) ? state.leases : [];
  const knowledge = state?.knowledge ?? null;
  return /* @__PURE__ */ jsx_runtime2.jsxs("section", {
    className: panel_module_default.section,
    "data-mstar-section": "state",
    children: [
      /* @__PURE__ */ jsx_runtime2.jsx("h2", {
        className: panel_module_default.sectionTitle,
        children: t("state.title")
      }),
      /* @__PURE__ */ jsx_runtime2.jsx("h3", {
        className: panel_module_default.subTitle,
        children: t("state.plans")
      }),
      plans.length === 0 ? /* @__PURE__ */ jsx_runtime2.jsx("p", {
        className: panel_module_default.empty,
        "data-mstar-empty": "no-plans",
        children: t("state.none")
      }) : /* @__PURE__ */ jsx_runtime2.jsx("ul", {
        className: panel_module_default.planList,
        children: plans.map((plan, i) => /* @__PURE__ */ jsx_runtime2.jsxs("li", {
          "data-plan-id": str(plan.id) ?? "unknown",
          "data-plan-status": str(plan.status) ?? "unknown",
          children: [
            /* @__PURE__ */ jsx_runtime2.jsx("span", {
              className: panel_module_default.planStatus,
              "data-status": str(plan.status) ?? "unknown",
              children: str(plan.status) ?? t("panel.unknown")
            }),
            /* @__PURE__ */ jsx_runtime2.jsx("span", {
              className: panel_module_default.planId,
              children: str(plan.id) ?? t("panel.unknown")
            })
          ]
        }, str(plan.id) ?? `plan-${i}`))
      }),
      /* @__PURE__ */ jsx_runtime2.jsx("h3", {
        className: panel_module_default.subTitle,
        children: t("state.residuals")
      }),
      residuals.length === 0 ? /* @__PURE__ */ jsx_runtime2.jsx("p", {
        className: panel_module_default.empty,
        "data-mstar-empty": "no-residuals",
        children: t("state.none")
      }) : /* @__PURE__ */ jsx_runtime2.jsx("ul", {
        className: panel_module_default.residualList,
        children: residuals.map((residual, i) => /* @__PURE__ */ jsx_runtime2.jsxs("li", {
          "data-residual-severity": str(residual.severity) ?? "unknown",
          children: [
            /* @__PURE__ */ jsx_runtime2.jsx("span", {
              className: panel_module_default.residualSeverity,
              children: str(residual.severity) ?? t("panel.unknown")
            }),
            /* @__PURE__ */ jsx_runtime2.jsx("span", {
              className: panel_module_default.residualCount,
              "data-residual-count": count(residual.count) === null ? "unknown" : String(residual.count),
              children: count(residual.count) === null ? t("panel.unknown") : String(residual.count)
            })
          ]
        }, str(residual.severity) ?? `residual-${i}`))
      }),
      /* @__PURE__ */ jsx_runtime2.jsx("h3", {
        className: panel_module_default.subTitle,
        children: t("state.branches")
      }),
      /* @__PURE__ */ jsx_runtime2.jsxs("dl", {
        className: panel_module_default.defList,
        children: [
          /* @__PURE__ */ jsx_runtime2.jsx("dt", {
            className: panel_module_default.defTerm,
            children: t("state.branch.iteration-base")
          }),
          /* @__PURE__ */ jsx_runtime2.jsx("dd", {
            className: panel_module_default.defValue,
            "data-field": "iteration-base-branch",
            children: str(state?.iterationBaseBranch) ?? t("state.none")
          }),
          /* @__PURE__ */ jsx_runtime2.jsx("dt", {
            className: panel_module_default.defTerm,
            children: t("state.branch.target")
          }),
          /* @__PURE__ */ jsx_runtime2.jsx("dd", {
            className: panel_module_default.defValue,
            "data-field": "target-branch",
            children: str(state?.targetBranch) ?? t("state.none")
          }),
          /* @__PURE__ */ jsx_runtime2.jsx("dt", {
            className: panel_module_default.defTerm,
            children: t("state.branch.spec-integration")
          }),
          /* @__PURE__ */ jsx_runtime2.jsx("dd", {
            className: panel_module_default.defValue,
            "data-field": "spec-integration-branch",
            children: str(state?.specIntegrationBranch) ?? t("state.none")
          })
        ]
      }),
      /* @__PURE__ */ jsx_runtime2.jsx("h3", {
        className: panel_module_default.subTitle,
        children: t("state.policy")
      }),
      /* @__PURE__ */ jsx_runtime2.jsxs("dl", {
        className: panel_module_default.defList,
        children: [
          /* @__PURE__ */ jsx_runtime2.jsx("dt", {
            className: panel_module_default.defTerm,
            children: t("state.policy.push")
          }),
          /* @__PURE__ */ jsx_runtime2.jsx("dd", {
            className: panel_module_default.defValue,
            "data-field": "push-policy",
            children: str(state?.pushPolicy) ?? t("state.none")
          }),
          /* @__PURE__ */ jsx_runtime2.jsx("dt", {
            className: panel_module_default.defTerm,
            children: t("state.policy.worktree")
          }),
          /* @__PURE__ */ jsx_runtime2.jsx("dd", {
            className: panel_module_default.defValue,
            "data-field": "worktree-mode",
            children: str(state?.worktreeMode) ?? t("state.none")
          }),
          /* @__PURE__ */ jsx_runtime2.jsx("dt", {
            className: panel_module_default.defTerm,
            children: t("state.policy.control-worktree")
          }),
          /* @__PURE__ */ jsx_runtime2.jsx("dd", {
            className: panel_module_default.defValue,
            "data-field": "control-worktree-path",
            children: str(state?.controlWorktreePath) ?? t("state.none")
          })
        ]
      }),
      /* @__PURE__ */ jsx_runtime2.jsx("h3", {
        className: panel_module_default.subTitle,
        children: t("state.leases")
      }),
      leases.length === 0 ? /* @__PURE__ */ jsx_runtime2.jsx("p", {
        className: panel_module_default.empty,
        "data-mstar-empty": "no-leases",
        children: t("state.none")
      }) : /* @__PURE__ */ jsx_runtime2.jsx("ul", {
        className: panel_module_default.leaseList,
        children: leases.map((lease, i) => /* @__PURE__ */ jsx_runtime2.jsxs("li", {
          "data-lease-plan": str(lease.planId) ?? "unknown",
          children: [
            /* @__PURE__ */ jsx_runtime2.jsx("span", {
              className: panel_module_default.leasePlan,
              children: str(lease.planId) ?? t("panel.unknown")
            }),
            /* @__PURE__ */ jsx_runtime2.jsx("span", {
              className: panel_module_default.leaseHolder,
              children: str(lease.holder) ?? t("panel.unknown")
            }),
            str(lease.worktreePath) !== null ? /* @__PURE__ */ jsx_runtime2.jsx("span", {
              className: panel_module_default.leaseWorktree,
              children: lease.worktreePath
            }) : null
          ]
        }, str(lease.planId) ?? `lease-${i}`))
      }),
      /* @__PURE__ */ jsx_runtime2.jsx("h3", {
        className: panel_module_default.subTitle,
        children: t("state.knowledge")
      }),
      knowledge === null ? /* @__PURE__ */ jsx_runtime2.jsx("p", {
        className: panel_module_default.empty,
        "data-mstar-empty": "no-knowledge",
        children: t("state.none")
      }) : /* @__PURE__ */ jsx_runtime2.jsxs("p", {
        className: panel_module_default.knowledge,
        "data-knowledge-docs": count(knowledge.docCount) === null ? "unknown" : String(knowledge.docCount),
        children: [
          /* @__PURE__ */ jsx_runtime2.jsx("span", {
            children: t("state.knowledge.docs", { count: count(knowledge.docCount) === null ? t("panel.unknown") : String(knowledge.docCount) })
          }),
          Array.isArray(knowledge.categories) && knowledge.categories.length > 0 ? /* @__PURE__ */ jsx_runtime2.jsx("span", {
            className: panel_module_default.knowledgeCategories,
            children: knowledge.categories.filter((category) => typeof category === "string").join(" · ")
          }) : null
        ]
      }),
      /* @__PURE__ */ jsx_runtime2.jsx("h3", {
        className: panel_module_default.subTitle,
        children: t("state.direction")
      }),
      /* @__PURE__ */ jsx_runtime2.jsx("p", {
        className: panel_module_default.direction,
        "data-direction": true,
        children: str(state?.direction) ?? t("state.none")
      })
    ]
  });
}

// src/client/panel/use-mstar-engine-status.ts
var EMPTY = { source: null, lastUpdated: null };
function latestEngineStatusRow(nodes) {
  for (let i = nodes.length - 1;i >= 0; i--) {
    const node = nodes[i];
    if (node.kind !== "context" || node.form !== "catalog")
      continue;
    const source = node.source;
    if (source?.kind === "mstar-engine-status")
      return node;
  }
  return null;
}
function sameView(a, b) {
  return a.source === b.source && a.lastUpdated === b.lastUpdated;
}
function selectEngineStatus(snapshot) {
  try {
    const row = latestEngineStatusRow(snapshot.nodes);
    if (row === null)
      return EMPTY;
    return { source: row.source, lastUpdated: row.time };
  } catch {
    return EMPTY;
  }
}
function useMstarEngineStatus(useSession) {
  const view = useSession(selectEngineStatus, sameView);
  return view ?? EMPTY;
}

// src/client/panel/PanelView.tsx
var jsx_runtime3 = require("react/jsx-runtime");
function enforcementLabel(t, enforcement) {
  if (enforcement === null || enforcement === undefined || typeof enforcement !== "object") {
    return t("panel.unknown");
  }
  const hard = bool(enforcement.hard);
  const source = str(enforcement.source);
  const flag = hard === null ? t("panel.unknown") : hard ? t("watermark.hard") : t("watermark.soft");
  return source === null ? flag : `${flag} (${source})`;
}
function formatTime(ms) {
  return new Date(ms).toLocaleTimeString("en-GB");
}
function PanelView({ t, useSession }) {
  const { source, lastUpdated } = useMstarEngineStatus(useSession);
  if (source === null || source === undefined) {
    return /* @__PURE__ */ jsx_runtime3.jsx("div", {
      className: panel_module_default.root,
      "data-mstar-panel": "waiting",
      children: /* @__PURE__ */ jsx_runtime3.jsx("p", {
        className: panel_module_default.empty,
        "data-mstar-empty": "waiting",
        children: t("empty.waiting")
      })
    });
  }
  const noHarness = source.harnessDir === null && source.state === null && source.iteration == null;
  return /* @__PURE__ */ jsx_runtime3.jsxs("div", {
    className: panel_module_default.root,
    "data-mstar-panel": noHarness ? "no-harness" : "panel",
    children: [
      /* @__PURE__ */ jsx_runtime3.jsxs("header", {
        className: panel_module_default.watermark,
        "data-mstar-watermark": true,
        children: [
          /* @__PURE__ */ jsx_runtime3.jsx("span", {
            children: t("watermark.version", { version: str(source.version) ?? t("panel.unknown") })
          }),
          /* @__PURE__ */ jsx_runtime3.jsx("span", {
            children: t("watermark.harness", { dir: source.harnessDir ?? t("watermark.none") })
          }),
          /* @__PURE__ */ jsx_runtime3.jsx("span", {
            children: t("watermark.enforcement", { value: enforcementLabel(t, source.enforcement) })
          })
        ]
      }),
      noHarness ? /* @__PURE__ */ jsx_runtime3.jsx("p", {
        className: panel_module_default.empty,
        "data-mstar-empty": "no-harness",
        children: t("empty.no-harness")
      }) : /* @__PURE__ */ jsx_runtime3.jsxs(jsx_runtime3.Fragment, {
        children: [
          source.iteration == null ? /* @__PURE__ */ jsx_runtime3.jsx("p", {
            className: panel_module_default.empty,
            "data-mstar-empty": "no-gate",
            children: t("iteration.no-compass")
          }) : /* @__PURE__ */ jsx_runtime3.jsx(IterationSection, {
            t,
            iteration: source.iteration
          }),
          source.state === null ? /* @__PURE__ */ jsx_runtime3.jsx("p", {
            className: panel_module_default.empty,
            "data-mstar-empty": "no-state",
            children: t("state.none")
          }) : /* @__PURE__ */ jsx_runtime3.jsx(StateSection, {
            t,
            state: source.state
          })
        ]
      }),
      /* @__PURE__ */ jsx_runtime3.jsxs("footer", {
        className: panel_module_default.freshness,
        "data-mstar-freshness": true,
        children: [
          typeof lastUpdated === "number" ? /* @__PURE__ */ jsx_runtime3.jsx("span", {
            children: t("freshness.last-updated", { time: formatTime(lastUpdated) })
          }) : null,
          /* @__PURE__ */ jsx_runtime3.jsx("span", {
            children: t("freshness.refresh-note")
          })
        ]
      })
    ]
  });
}

// src/client/index.ts
var inject = ["slots", "sessions", "locale"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-mstar-panel: dictionaries");
  ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view",
    id: "mstar-workflow",
    order: 20,
    label: () => ctx.locale.bind(NS)("view.mstar-workflow"),
    locale: NS
  }, PanelView));
}

return module.exports; } });
