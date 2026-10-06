// Minimal in-memory stand-in for @opencode/client: a shared event bus plus
// recorded calls. Tests script server behaviour by emitting events.
export function fakeClient(handlers = {}) {
  const subscribers = new Set();
  const calls = [];
  const emit = (type, data) => { for (const s of subscribers) s.push({ type, data }); };
  const record = (name) => async (input) => {
    calls.push({ name, input });
    return handlers[name] ? handlers[name](input, { emit }) : {};
  };
  const client = {
    event: {
      subscribe({ signal } = {}) {
        const queue = [];
        const waiting = [];
        let closed = false;
        const sub = {
          push(v) { const w = waiting.shift(); w ? w({ done: false, value: v }) : queue.push(v); },
          close() { closed = true; subscribers.delete(sub); for (const w of waiting.splice(0)) w({ done: true }); },
        };
        signal?.addEventListener("abort", () => sub.close(), { once: true });
        return {
          [Symbol.asyncIterator]() {
            subscribers.add(sub);
            return {
              next: () => queue.length ? Promise.resolve({ done: false, value: queue.shift() })
                : closed ? Promise.resolve({ done: true }) : new Promise((r) => waiting.push(r)),
              return: () => { sub.close(); return Promise.resolve({ done: true }); },
            };
          },
        };
      },
    },
    session: {
      prompt: record("session.prompt"),
      create: record("session.create"),
      diff: record("session.diff"),
      list: record("session.list"),
    },
    message: { list: record("message.list") },
    permission: { reply: record("permission.reply") },
  };
  return { client, calls, emit, subscribers, closeAll: () => { for (const s of [...subscribers]) s.close(); } };
}
