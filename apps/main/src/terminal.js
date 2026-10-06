// Yard terminal: shell-backed run/poll/kill plus PTY lifecycle + live frames.
// PTY live frames ride a websocket ticket owned here (Electron main / Node):
// POST /api/pty/:id/connect-token with `x-opencode-ticket: 1` mints a
// single-use ticket (60s TTL, scoped to ptyID+directory); the websocket
// GET /api/pty/:id/connect?location[directory]=…&ticket=… then streams raw
// UTF-8 terminal chunks as text frames, one binary control frame (0x00 byte
// + JSON `{"cursor": N}`) after replay, and stdin as raw text frames back.
// Shell polling is the one-shot run/output/kill path; PTY is the live path.
import { ensureClient } from "./service.js";

const textdec = new TextDecoder();
const sockets = new Map(); // ptyID -> { ws, cursor }

function loc(directory) {
  return directory ? { location: { directory } } : {};
}

export async function termStart(command, directory, timeout) {
  const { client } = await ensureClient();
  if (!command || typeof command !== "string") throw new Error("term: command required");
  const r = await client.shell.create({
    ...loc(directory ?? process.cwd()),
    command,
    cwd: directory ?? process.cwd(),
    timeout: timeout ?? 30000,
  });
  return r.data ?? r;
}

export async function termOutput(id, directory, cursor) {
  const { client } = await ensureClient();
  const r = await client.shell.output({ id, ...loc(directory ?? process.cwd()), ...(cursor != null ? { cursor } : {}) });
  return r.data ?? r;
}

export async function termGet(id, directory) {
  const { client } = await ensureClient();
  const r = await client.shell.get({ id, ...loc(directory ?? process.cwd()) });
  return r.data ?? r;
}

export async function termKill(id, directory) {
  const { client } = await ensureClient();
  await client.shell.remove({ id, ...loc(directory ?? process.cwd()) });
  return { ok: true, id };
}

export async function ptyOpen(directory, title) {
  const { client } = await ensureClient();
  const r = await client.pty.create({
    ...loc(directory ?? process.cwd()),
    cwd: directory ?? process.cwd(),
    title: title ?? "jarvis-yard",
  });
  return r.data ?? r;
}

export async function ptyResize(ptyID, directory, rows, cols) {
  const { client } = await ensureClient();
  const r = await client.pty.update({ ptyID, ...loc(directory ?? process.cwd()), size: { rows, cols } });
  return r.data ?? r;
}

export async function ptyClose(ptyID, directory) {
  ptyDetach(ptyID);
  const { client } = await ensureClient();
  await client.pty.remove({ ptyID, ...loc(directory ?? process.cwd()) });
  return { ok: true, ptyID };
}

export async function ptyList(directory) {
  const { client } = await ensureClient();
  const r = await client.pty.list(loc(directory ?? process.cwd()));
  return r.data ?? r;
}

// Single-use ticket per connection: the server consumes it on upgrade.
async function ptyTicket(client, ptyID, directory) {
  const r = await client.pty.connect.token(
    { ptyID, ...loc(directory ?? process.cwd()) },
    { headers: { "x-opencode-ticket": "1" } },
  );
  const token = r.data ?? r;
  if (!token?.ticket) throw new Error("pty: connect token returned no ticket");
  return token.ticket;
}

function ptyWsUrl(endpoint, ptyID, directory, ticket, cursor) {
  const base = new URL(endpoint.url);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `/api/pty/${encodeURIComponent(ptyID)}/connect`;
  base.search = "";
  base.searchParams.set("location[directory]", directory ?? process.cwd());
  base.searchParams.set("ticket", ticket);
  if (cursor != null) base.searchParams.set("cursor", String(cursor));
  return base.toString();
}

function decodeFrame(data) {
  if (typeof data === "string") return { kind: "chunk", chunk: data };
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length > 1 && bytes[0] === 0) {
    try {
      return { kind: "meta", cursor: JSON.parse(textdec.decode(bytes.slice(1))).cursor };
    } catch {
      return null;
    }
  }
  try {
    return { kind: "chunk", chunk: textdec.decode(bytes) };
  } catch {
    return null;
  }
}

// Attach a live frame stream to an existing PTY. hooks: { onChunk, onMeta, onClose }.
// Detaches any previous socket for the same ptyID first (no leaked sockets).
export async function ptyAttach(ptyID, directory, hooks = {}) {
  const { client, endpoint } = await ensureClient();
  if (!ptyID || typeof ptyID !== "string") throw new Error("pty: ptyID required");
  const previous = sockets.get(ptyID);
  ptyDetach(ptyID);
  const dir = directory ?? process.cwd();
  const ticket = await ptyTicket(client, ptyID, dir);
  const ws = new WebSocket(ptyWsUrl(endpoint, ptyID, dir, ticket, previous?.cursor ?? hooks.cursor));
  if (typeof ws.binaryType !== "undefined") ws.binaryType = "arraybuffer";
  const entry = { ws, cursor: previous?.cursor ?? hooks.cursor ?? null, opened: false, intentional: false };
  sockets.set(ptyID, entry);
  const done = (code, reason) => {
    if (sockets.get(ptyID) === entry) sockets.delete(ptyID);
    try { ws.close(); } catch {}
    if (entry.opened && !entry.intentional) hooks.onClose?.({ ptyID, code, reason });
  };
  ws.addEventListener("open", () => {
    entry.opened = true;
    hooks.onOpen?.({ ptyID });
  });
  ws.addEventListener("message", async (e) => {
    let data = e.data;
    if (typeof Blob !== "undefined" && data instanceof Blob) data = await data.arrayBuffer();
    const frame = decodeFrame(data);
    if (!frame) return;
    if (frame.kind === "meta") {
      entry.cursor = frame.cursor;
      hooks.onMeta?.({ ptyID, cursor: frame.cursor });
    } else {
      if (entry.cursor != null) entry.cursor += frame.chunk.length;
      hooks.onChunk?.({ ptyID, chunk: frame.chunk, cursor: entry.cursor });
    }
  });
  ws.addEventListener("close", (e) => done(e.code, e.reason));
  ws.addEventListener("error", () => {});
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      ptyDetach(ptyID);
      reject(new Error("pty: websocket open timeout"));
    }, 10000);
    ws.addEventListener("open", () => { clearTimeout(to); resolve(); }, { once: true });
    ws.addEventListener("close", () => { clearTimeout(to); reject(new Error("pty: websocket closed before open")); }, { once: true });
  });
  return { ok: true, ptyID };
}

export async function ptyWrite(ptyID, data) {
  const entry = sockets.get(ptyID);
  if (!entry) throw new Error(`pty: not attached: ${ptyID}`);
  if (typeof data !== "string" || data.length === 0) throw new Error("pty: data required");
  entry.ws.send(data);
  return { ok: true, ptyID };
}

// Close the frame socket without killing the PTY.
export function ptyDetach(ptyID) {
  const entry = sockets.get(ptyID);
  if (!entry) return { ok: false, ptyID, attached: false };
  sockets.delete(ptyID);
  entry.intentional = true;
  try { entry.ws.close(); } catch {}
  return { ok: true, ptyID, attached: false };
}

// Detach every live socket (app shutdown). Never throws.
export function ptyDetachAll() {
  for (const ptyID of [...sockets.keys()]) ptyDetach(ptyID);
  return { ok: true };
}

export function ptyAttached() {
  return [...sockets.keys()];
}
