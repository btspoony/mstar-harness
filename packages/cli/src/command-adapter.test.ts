import { getCommandDefinitions } from "@mstar-harness/commands";
import { renderCommandContract, resolveCliSessionIdentity } from "./command-adapter";

const originalSessionId = process.env.MSTAR_HOST_SESSION_ID;

afterEach(() => {
  if (originalSessionId === undefined) delete process.env.MSTAR_HOST_SESSION_ID;
  else process.env.MSTAR_HOST_SESSION_ID = originalSessionId;
});

test("CLI session identity prefers the flag and attributes its source", () => {
  process.env.MSTAR_HOST_SESSION_ID = "env-session";
  expect(resolveCliSessionIdentity("flag-session")).toEqual({
    sessionId: "flag-session",
    sessionIdSource: "flag",
  });
});

test("CLI session identity resolves and attributes the environment fallback", () => {
  process.env.MSTAR_HOST_SESSION_ID = "env-session";
  expect(resolveCliSessionIdentity(undefined)).toEqual({
    sessionId: "env-session",
    sessionIdSource: "env",
  });
});
test("CLI session identity treats empty and whitespace environment values as unset", () => {
  for (const value of ["", "   ", "\t\n"]) {
    process.env.MSTAR_HOST_SESSION_ID = value;
    expect(resolveCliSessionIdentity(undefined)).toEqual({});
  }
});


test("CLI session identity omits both value and source when unset", () => {
  delete process.env.MSTAR_HOST_SESSION_ID;
  expect(resolveCliSessionIdentity(undefined)).toEqual({});
});

test("CLI contract declares session resolution and legacy-route exceptions", () => {
  const definition = getCommandDefinitions().find((candidate) => candidate.id === "plan.bind");
  expect(definition).toBeDefined();
  const contract = renderCommandContract(definition!, "cli");
  expect(contract).toContain("Session identity resolves from --session-id or MSTAR_HOST_SESSION_ID");
  expect(contract).toContain("active token-authorized writes it is attribution, not authorization");
  expect(contract).toContain("legacy pre-activation coordinator bootstrap");
  expect(contract).toContain("requires an explicit --session-id and rejects the environment value");
  expect(contract).toContain("Legacy `plan bind --resume` ignores ambient environment identity and refuses a declared identity");
});
test("MCP contract retains caller-supplied identity requirement", () => {
  const definition = getCommandDefinitions().find((candidate) => candidate.id === "plan.bind");
  expect(definition).toBeDefined();
  const contract = renderCommandContract(definition!, "mcp");
  expect(contract).toContain("must be supplied by the caller on each MCP call");
  expect(contract).not.toContain("connection context");
  expect(contract).not.toContain("Derived:");
});
