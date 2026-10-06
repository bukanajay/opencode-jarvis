import { Rpc } from "@opencode/plugin/rpc";

export const Jarvis = Rpc.define({
  id: "jarvis",
  methods: {
    dispatchWorker: {
      input: {
        type: "object",
        properties: {
          task: { type: "string" },
          agent: { type: "string" },
        },
        required: ["task", "agent"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
    workerList: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { sessions: { type: "array", items: { type: "string" } } },
        required: ["sessions"],
        additionalProperties: false,
      },
    },
    configConfirm: {
      input: {
        type: "object",
        properties: {
          pendingID: { type: "string" },
          confirmed: { type: "boolean" },
        },
        required: ["pendingID", "confirmed"],
        additionalProperties: false,
      },
    },
  },
  events: {
    workerState: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          state: { type: "string" },
        },
        required: ["sessionID", "state"],
        additionalProperties: false,
      },
    },
    configPending: {
      schema: {
        type: "object",
        properties: {
          pendingID: { type: "string" },
          summary: { type: "string" },
          widening: { type: "boolean" },
        },
        required: ["pendingID", "summary", "widening"],
        additionalProperties: false,
      },
    },
  },
});
