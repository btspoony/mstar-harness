# Test reliability

A test is reliable when it holds under the topology it actually runs in, not only alone on a quiet machine. This file is judgement for designing, reviewing and diagnosing tests and fixtures that own a port, process, clock, temporary root, global state, subprocess or asynchronous teardown. Which commands to run is a different decision — see `evidence-selection.md`.

## Model the execution topology

Assume these layers can overlap unless the active runner configuration proves otherwise: cases in one file, separate files or worker processes, independent processes inside one job, and separate jobs whose runners share one host.

Process isolation does not isolate host ports, predictable filesystem paths, external services, databases, sockets or inherited child processes. For every resource a test acquires, be able to name five things: its owner, its atomic allocation mechanism, its observable readiness signal, its registered cleanup, and its quiescent completion signal.

Do not serialize an entire suite because one fixture lacks isolation. Narrow the exclusive scope or fix the allocation first: a sequential block separates the cases inside it and still cannot protect a host resource from another file, process, job or runner.

## Allocate resources atomically

Use the resource owner's allocator instead of checking availability and claiming it later. Bind a loopback listener to port zero and read the assigned address only after the server reports that it is listening; never scan for a free port and bind it afterwards. Create a private root per test with a fresh temporary directory rather than acquiring a predictable shared path. Give shared databases, sockets, sessions and output locations a unique per-test namespace, and use exclusive creation where a path must not already exist.

Keep stable recorded identifiers separate from ephemeral transport addresses: translate inside the fixture instead of forcing the live resource onto the recorded value. A literal path or URL used only as parser input or as an expected value is not an acquired resource and needs no uniqueness.

## Contain process-global state

Environment variables, working directory, fake timers, locale and timezone, module mocks, registries, console hooks, `globalThis` and global request interception are exclusive mutable resources: two cases touching them at once is a defect even when each restores its own.

Prefer an injected dependency or an instance-local adapter. Where mutation is required, capture whether the original value was absent or present, restore that exact state, register the restoration immediately, keep the mutation inside the smallest `try/finally`, and keep an `afterEach` fallback where a failure before the local `finally` is plausible. Intercept the narrowest call the fixture owns rather than the whole surface.

Set the state a case needs before it asserts instead of inheriting whatever the previous case left. A test whose result depends on run order is a defect even while the whole file passes.

## Respect platform-owned values

A value the operating system owns does not always return the way a test wrote it: environment names may fold case, file handles may be released asynchronously, and permission or signal semantics may be absent. Where an assertion depends on a write-back, take the expected value from a fresh read rather than from memory. A case that genuinely cannot hold on a platform is excluded there explicitly with the reason named, never weakened for every platform.

## Synchronize on state

A fixed sleep is not evidence that setup completed or cleanup settled: it spends elapsed time instead of the state the test needs, and a loaded runner spends that time before the work lands. Where the fixture owns the asynchronous seam, expose a gate the fixture settles and await the product's own completion point instead of elapsed time.

Wait on an explicit readiness event, handshake, state transition, owned promise or externally observable condition. Use a deferred promise or barrier to place a race at a deterministic point and prove the operations overlap. A timeout bounds a wait; it never makes the assertion correct. Do not assert scheduler-dependent ordering unless that ordering is the product behavior under test. Where time itself is the subject, inject or fake the clock and restore real timers.

## Budget timeouts against the lane

A per-case or per-hook timeout overrides the runner's default instead of yielding to it, so a literal below the lane's budget lowers what CI already granted, while the same literal reads as a widening on a host whose default is smaller. A suite bound by process creation takes the lane budget; a tighter value carries its reason.

Raise the hook budget together with the case budget, because setup and teardown pay the same contention and lifting only the case budget moves the failure into the hook. Where a timeout is the test's subject, keep the outer wait far larger than the timeout under test, or load decides which deadline reports first.

## Dispose to quiescence

Register cleanup immediately after acquisition, so an assertion failure also releases the resource. Cleanup stops new callbacks and requests, detaches listeners, restores global hooks, terminates owned work, and awaits child exit, server close, worker termination or the equivalent completion signal. Calling `abort()`, `close()` or `kill()` without awaiting the owned completion signal is incomplete teardown; where late completion is possible, prove that disposal prevents it from mutating another test.

## Prove the intended regression

Observe an ordinary regression fail before the fix where practical. For a new static or corpus guard, temporarily introduce the rejected case and watch the intended failure. A race is proved with a barrier that forces overlap; repeated execution alone is not a race test. Cross-process isolation is proved by running independent test processes concurrently, which is evidence a single-process run cannot give.

Where a fixture spawns with its own deadline, assert that no signal or timeout ended the child before asserting its exit status, or a killed child reports as a status mismatch. Verify external state, events, files, logs, exits and disposal rather than trusting the component's self-report. A stress run supplements a deterministic regression; it does not replace one.

## Reject flake-masking

None of these is a root-cause fix for a test that fails deterministically: raising a timeout without naming the awaited state; adding retries; serializing every file; swallowing an error or an unhandled rejection; weakening an assertion; normalizing unstable behavior away; sleeping before an assertion or a cleanup.

Retries stay legitimate for a documented transient external provider under that provider's own policy, kept at the external boundary. Restoring a budget is not masking: returning a suite to the lane budget it already had, or sizing a bounded retry to contention actually measured, names the awaited work instead of inventing headroom around an unexamined wait.

## What is not a violation

- A literal path or URL used only as parser input or as an expected value; restoring a timestamp whose round trip the assertion tolerates, taking the expected value from a fresh read where the restoration matters.
- A timeout set to the lane budget with the awaited state named; a narrow sequential scope for a resource whose owner really is exclusive.

## Keep the test out of the producer's job

Call the owner's check instead of re-implementing its rule in the test. A second implementation of a producer's validation, freshness or lifecycle rule can disagree with the real one, and once it does neither is authoritative; where the producer owns the assertion, the test's job is to invoke it and report its failure.

Construct invalid states in the domain's own terms — remove a required table, truncate through an open descriptor — rather than by raw bytes or a filesystem side effect, which smuggle platform behavior into the assertion and fail only where that behavior differs.

Make a failure name the offending entry — the path, row or field that disagrees — rather than printing two opaque values; the detailed evidence belongs in the single implementation that owns the check, not in a test-side copy of it.

## Assert the semantic, not the bytes

The banned forms are narrow and specific: a directory's file bytes or a base64/hex dump of them; a digest equal to `createHash(...)` of the same input, or to a literal digest constant; a file equal to a hard-coded full text, even held in a named constant; and a version or module version asserted against a hard-coded literal — derive it from its owning source (the manifest, a directory listing, the CLI) instead. Each is volatile — database sidecars, write-ahead residency, build drift, whitespace and version bumps move it — and each hides what the test means.

A version or hash passed in as an input — a fixture field, a manifest value — is allowed: the prohibition sits on what the assertion expects, not on constants a fixture supplies. A requirement that genuinely needs a byte, digest or pinned-version comparison is an open question to confirm, not a test to write.

Assert the observable semantic instead: the rows a write created, the field a caller reads, the refusal a command emits, the relation between a computed value and its input. Text a user or model reads is behaviour, so assert it through parsed fields, exit status, a refusal's structured code and message fields, or the rendered state — never by comparing a literal transcript, a byte blob or a whole-file text.
