/** Plugin log channel; OpenCode captures plugin stdout/stderr in its server log. */
export type StatusLogger = (level: "info" | "warn" | "error", message: string) => void;

export const defaultStatusLogger: StatusLogger = (level, message) => {
  const line = `[mstar-harness] ${message}`;
  if (level === "warn") console.warn(line);
  else if (level === "error") console.error(line);
  else console.log(line);
};
