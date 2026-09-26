export type CursorScope = "global" | "project";
export type CursorDoctorResult = {
    location: string;
    errors: string[];
};
/** Cursor install roots — shared by doctor and plugin-version discovery. */
export declare function globalInstallPath(home?: string): string;
export declare function projectInstallPath(projectRoot?: string): string;
/** Assemble read-only Cursor checkout and plugin diagnostics for the selected install scope. */
export declare function diagnoseCursorHost(scope: CursorScope, roots?: {
    project?: string;
    global?: string;
}): CursorDoctorResult;
