const records = new Map();
export const calls = [];
export const store = {
  async put(ref) {
    calls.push(["put", ref.kind, ref.key]);
    records.set(`${ref.kind}:${ref.key}`, ref.payload ?? null);
  },
  async get(ref) {
    calls.push(["get", ref.kind, ref.key]);
    return records.get(`${ref.kind}:${ref.key}`);
  },
  async delete(ref) {
    calls.push(["delete", ref.kind, ref.key]);
    records.delete(`${ref.kind}:${ref.key}`);
  },
};
export function seed(kind, key, payload) {
  records.set(`${kind}:${key}`, payload);
}
export default store;
