/** The exact CSP the plan fixes; identical on every response. */
export declare const DASHBOARD_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";
/** `startDashboard` options. There is deliberately no host/bind option. */
export type StartDashboardOptions = {
    harnessDir: string;
    /** TCP port; default 0 = OS-selected. */
    port?: number;
    /** Optional project selector validated before the server starts. */
    projectId?: string;
};
/** A running dashboard. `close()` is idempotent and bounded. */
export type RunningDashboard = {
    url: string;
    close(): Promise<void>;
};
/**
 * Start the dashboard on `127.0.0.1`. Resolves only after the socket listens;
 * the resolved URL carries the actual (possibly OS-selected) port.
 */
export declare function startDashboard(options: StartDashboardOptions): Promise<RunningDashboard>;
