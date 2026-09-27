import { type EvidenceAssessment, type SddEvidenceRecord } from "@mstar-harness/engine";
import { type CommandEffects } from "@mstar-harness/commands";
type VerifyRequest = {
    sddDir: string;
    planId: string;
    taskId: string;
    runId: string;
    targetPath?: string;
};
export type McpEffects = Omit<CommandEffects, "captureSddEvidence" | "verifySddEvidence"> & {
    withInput<T>(input: unknown, request: {
        cwd: string;
        signal: AbortSignal;
    }, operation: () => Promise<T>): Promise<T>;
    captureSddEvidence(requestPath: string, argv: readonly string[]): Promise<{
        runDir: string;
        record: SddEvidenceRecord;
        exitCode: number;
    }>;
    verifySddEvidence(request: VerifyRequest): Promise<EvidenceAssessment>;
};
export declare function createMcpEffects(services: Array<{
    close(): Promise<void>;
}>): McpEffects;
export {};
