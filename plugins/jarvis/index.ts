import { Plugin } from "@opencode/plugin";
import { Jarvis } from "./rpc.js";

export default Plugin.define({
  id: "jarvis",
  async setup(ctx) {
    await ctx.rpc.register(Jarvis, {
      dispatchWorker: async (input, _context) => {
        const { task, agent } = input as { task: string; agent: string };
        const session = await ctx.client.session.create({
          title: `worker: ${task.slice(0, 48)}`,
        } as never);
        const id = (session as { id?: string; data?: { id?: string } }).id
          ?? (session as { data?: { id?: string } }).data?.id
          ?? "";
        await ctx.client.session.prompt({
          sessionID: id,
          agent,
          text: task,
        } as never);
        return { sessionID: id };
      },
      workerList: async () => ({ sessions: [] }),
      configConfirm: async () => {},
    });
  },
});
