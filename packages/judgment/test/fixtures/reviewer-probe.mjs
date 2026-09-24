const runId = process.argv.at(-1);
if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) process.exit(2);
const emit = (type, detail) => process.stdout.write(`${JSON.stringify({ type, at: performance.now(), runId, ...(detail === undefined ? {} : { detail }) })}\n`);
emit("start", "account-free-component-probe");
emit("baseline-frozen", "supervisor-owns-baseline");
emit("request", "bounded-mailbox-only");
emit("complete", "component-worker-complete");
