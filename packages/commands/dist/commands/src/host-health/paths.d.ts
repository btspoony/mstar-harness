/** Resolve the project root for CLI operations, preserving its environment precedence. */
export declare function resolveProjectRoot(): string;
/** Resolve derived paths under a lexical root; symlink containment remains the caller's responsibility. */
export declare function joinWithinRoot(root: string, ...segments: string[]): string;
/** Resolve a relative CLI path argument from the project root; absolute arguments pass through unchanged. */
export declare function resolveCliPath(userPath: string): string;
