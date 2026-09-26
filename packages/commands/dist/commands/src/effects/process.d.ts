export type ProcessRequest = {
    argv: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    stdin?: string;
    signal: AbortSignal;
};
export type ProcessResult = {
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
};
/** Run one admitted argv vector without shell interpretation or protocol-fd inheritance. */
export declare function spawnProcess(request: ProcessRequest): Promise<ProcessResult>;
