export type Utterance = {
  id: string;
  text: string;
  source: "typed" | "speech";
  engine: "speech-analyzer" | "parakeet-v3" | "typed";
  committedAt: number;
};

export type CaptionPartial = {
  id: string;
  text: string;
  revision: number;
};

export type DeckIntent =
  | { kind: "utterance.commit"; utterance: Utterance }
  | { kind: "session.interrupt"; sessionID: string }
  | { kind: "session.select"; sessionID: string }
  | { kind: "permission.respond"; requestID: string; decision: "allow" | "deny" }
  | { kind: "app.command"; name: string; args: unknown };

export type AuditEntry = {
  at: number;
  bucket: "shell" | "session" | "server-config";
  what: string;
  live: boolean;
  needsRestart: boolean;
  note: string;
};

export type MainEvent =
  | { kind: "caption.partial"; partial: CaptionPartial }
  | { kind: "session.stream"; sessionID: string; delta: unknown }
  | { kind: "session.tool"; sessionID: string; tool: unknown; state: "start" | "idle" }
  | { kind: "permission.waiting"; request: unknown }
  | { kind: "settings.applied"; entry: AuditEntry };
