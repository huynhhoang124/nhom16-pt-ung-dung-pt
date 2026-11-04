// Persist only a digest, idempotency key and command ID, never administrative payload/plates.
const ordered = (value) =>
  Array.isArray(value)
    ? value.map(ordered)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, ordered(value[k])]),
        )
      : value;
export function makeBroadcastRequest({ storage, storageKey, digest, newKey }) {
  let current;
  try {
    current = JSON.parse(storage.getItem(storageKey));
  } catch {}
  if (
    !current ||
    typeof current.fingerprint !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(current.key ?? "")
  )
    current = null;
  return {
    read: () => current,
    async prepare(input, userId) {
      const fingerprint = await digest(JSON.stringify(ordered(input)));
      if (current?.fingerprint !== fingerprint)
        current = { fingerprint, key: newKey() };
      current = {
        ...current,
        broadcastId: `${userId}:broadcast-${current.key}`,
      };
      try {
        storage.setItem(storageKey, JSON.stringify(current));
      } catch {}
      return current;
    },
    clear() {
      current = null;
      try {
        storage.removeItem(storageKey);
      } catch {}
    },
  };
}
export async function digestBroadcast(value) {
  if (globalThis.crypto?.subtle)
    return [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      ),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  let hash = 2166136261;
  for (const ch of value) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return String(hash >>> 0);
}
