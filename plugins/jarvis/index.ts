import { Plugin } from "@opencode/plugin";
import { Jarvis } from "./rpc.js";

function sessionIDOf(session: unknown): string {
  const s = session as { id?: string; data?: { id?: string } };
  return s.id ?? s.data?.id ?? "";
}

export default Plugin.define({
  id: "jarvis",
  async setup(ctx) {
    await ctx.rpc.register(Jarvis, {
      dispatchWorker: async (input, _context) => {
        const { task, agent } = input as { task: string; agent: string };
        // Child session under the calling location; title marks fleet membership.
        // Model follows session default (Luna) unless the caller switched it.
        const session = await ctx.client.session.create({
          agent: agent || "build",
          title: `worker: ${task.slice(0, 48)}`,
        });
        const id = sessionIDOf(session);
        if (!id) throw new Error("worker session not created");
        await ctx.client.session.prompt({ sessionID: id, text: task });
        return { sessionID: id };
      },
      workerList: async () => {
        const list = (await ctx.client.session.list()) as unknown as {
          sessions?: Array<{ id?: string }>;
          data?: Array<{ id?: string }>;
        };
        const arr = list.sessions ?? list.data ?? [];
        const ids = (Array.isArray(arr) ? arr : []).map((s) => s.id ?? "").filter(Boolean);
        return { sessions: ids };
      },
      configConfirm: async () => {},
    });
  },
});
