import type { CommandDefinition } from "../types.js";
export declare function getStatusCommandDefinitions(): readonly CommandDefinition[];
export type StatusCommandId = "status.validate" | "status.workflow-close" | "status.archive-residuals" | "status.findings-cleanup" | "status.tech-debt" | "status.backlog-register" | "status.backlog-close";
