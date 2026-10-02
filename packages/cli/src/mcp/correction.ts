import type { Transport } from "@modelcontextprotocol/server";

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^mstar/, "");
}

function distance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(current[column - 1] + 1, previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length];
}

export function correctiveMessage(name: string, catalog: Iterable<string>): string {
  const tools = [...catalog].sort();
  const normalized = normalize(name);
  const exact = tools.find((tool) => normalize(tool) === normalized);
  const editDistanceMatch = tools
    .map((tool) => ({ tool, distance: distance(normalized, normalize(tool)) }))
    .filter(({ distance: score }) => score <= 2)
    .sort((left, right) => left.distance - right.distance || (left.tool < right.tool ? -1 : left.tool > right.tool ? 1 : 0))[0]?.tool;
  const prefix = tools.find((tool) => normalize(tool).startsWith(normalized) && normalize(tool).length - normalized.length <= 3);
  const nearest = exact ?? editDistanceMatch ?? prefix;
  return nearest === undefined
    ? `Tool ${name} not found. Call tools/list for the full catalog.`
    : `Tool ${name} not found. Did you mean ${nearest}? Call tools/list for the full catalog.`;
}

export function withToolCorrection(transport: Transport, catalog: () => Iterable<string>): Transport {
  const requests = new Set<string | number>();
  const wrapped: Transport = {
    start: () => transport.start(),
    async send(message, options) {
      if ("error" in message && message.id !== null && message.id !== undefined && requests.has(message.id)
        && message.error.code === -32602 && /^Tool .+ not found$/.test(message.error.message)) {
        requests.delete(message.id);
        const name = /^Tool (.+) not found$/.exec(message.error.message)![1];
        await transport.send({ ...message, error: { ...message.error, message: correctiveMessage(name, catalog()) } }, options);
        return;
      }
      if (!("method" in message) && "id" in message && message.id !== null && message.id !== undefined) requests.delete(message.id);
      await transport.send(message, options);
    },
    close: () => transport.close(),
    get onclose() { return transport.onclose; },
    set onclose(handler) { transport.onclose = handler; },
    get onerror() { return transport.onerror; },
    set onerror(handler) { transport.onerror = handler; },
    get onmessage() { return transport.onmessage; },
    set onmessage(handler) {
      transport.onmessage = (message, extra) => {
        if ("method" in message && message.method === "tools/call" && "id" in message) requests.add(message.id);
        handler?.(message, extra);
      };
    },
    get sessionId() { return transport.sessionId; },
    set sessionId(value) { transport.sessionId = value; },
    get setProtocolVersion() { return transport.setProtocolVersion; },
    set setProtocolVersion(value) { transport.setProtocolVersion = value; },
    get hasPerRequestStream() { return transport.hasPerRequestStream; },
  };
  return wrapped;
}
