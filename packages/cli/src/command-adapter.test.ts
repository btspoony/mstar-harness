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

test("CLI session identity omits both value and source when unset", () => {
  delete process.env.MSTAR_HOST_SESSION_ID;
  expect(resolveCliSessionIdentity(undefined)).toEqual({});
});

test("CLI contract declares session resolution order and the coordinator exception", () => {
  const definition = getCommandDefinitions().find((candidate) => candidate.id === "plan.bind");
  expect(definition).toBeDefined();
  const contract = renderCommandContract(definition!, "cli");
  expect(contract).toContain("--session-id takes precedence over MSTAR_HOST_SESSION_ID");
  expect(contract).toContain("Coordinator bootstrap (`plan bind --coordinator`) requires an explicit --session-id");
});
