type ZcodeScope = "global" | "project";
export type ZcodeDoctorResult = {
    location: string;
    errors: string[];
};
export type ZcodeHostRoots = {
    pluginsRoot?: string;
    projectRoot?: string;
    harnessRepoPath?: string;
};
/** Assemble read-only ZCode doctor findings from synthetic or real host roots. */
export declare function diagnoseZcodeHost(scope: ZcodeScope, roots?: ZcodeHostRoots): ZcodeDoctorResult;
export {};
