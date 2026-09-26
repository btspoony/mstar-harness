type JudgmentInvocation = Readonly<{
    cwd: string;
    workspace: string;
    input: Readonly<{
        kind: "file";
        path: string;
    }> | Readonly<{
        kind: "stdin";
    }>;
    pilotPath: string | null;
}>;
type JudgmentCliResult = Readonly<{
    schema: string;
    contractRevision: string;
    status: "disabled" | "recorded" | "unavailable" | "invalid" | "cancelled";
    advice: null;
    code?: string;
}>;
import type { CommandDefinition } from "../types.js";
export type JudgmentProvider = (request: Readonly<{
    invocation: JudgmentInvocation;
    signal: AbortSignal;
    readInput(): Promise<string>;
}>) => Promise<JudgmentCliResult>;
export declare function getJudgmentCommandDefinitions(provider?: JudgmentProvider): readonly CommandDefinition[];
export {};
