/** Parse `omp plugin list --json` output into flat npm + marketplace records. */
export declare function parseOmpPluginList(raw: string): Array<Record<string, unknown>>;
/** Find the installed Morning Star plugin in an omp plugin-list response. */
export declare function findInstalledPlugin(plugins: Array<Record<string, unknown>>): Record<string, unknown> | undefined;
export type OmpDoctorInput = {
    harnessRepoPath: string;
    scope: "global" | "project";
    ompAvailable: boolean;
    installedPlugins: Array<Record<string, unknown>>;
    localHarnessRepoErrors: string[];
    missingGitignoreEntries: string[];
};
/** Assemble read-only omp doctor findings from host artifacts and CLI probe results. */
export declare function diagnoseOmpHost(input: OmpDoctorInput): {
    location: string;
    errors: string[];
};
