// Yard terminal: shell-backed run/poll/kill plus PTY lifecycle.
// PTY live frames ride a websocket ticket; streaming proxy is follow-up work.
// Shell polling is the complete run/output/kill path today.
import { ensureClient } from "./service.js";

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
  const { client } = await ensureClient();
  await client.pty.remove({ ptyID, ...loc(directory ?? process.cwd()) });
  return { ok: true, ptyID };
}

export async function ptyList(directory) {
  const { client } = await ensureClient();
  const r = await client.pty.list(loc(directory ?? process.cwd()));
  return r.data ?? r;
}
