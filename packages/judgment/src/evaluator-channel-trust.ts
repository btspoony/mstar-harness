const attestedChannels = new WeakSet<object>();

export function attestEvaluatorChannel<T extends object>(channel: T): T {
  attestedChannels.add(channel);
  return channel;
}

export function isAttestedEvaluatorChannel(channel: unknown): channel is object {
  return channel !== null && typeof channel === "object" && attestedChannels.has(channel);
}
