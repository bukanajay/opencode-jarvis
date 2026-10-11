// Secrets (Slack tokens, later connector keys). Encrypted with the OS keychain
// via Electron safeStorage and written to ~/.config/jarvis/secrets.json (0600).
// Never stored in plain text: without a working cipher, saving refuses.
// The cipher is injected so this module stays testable outside Electron.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function secretsPath() {
  return process.env.JARVIS_SECRETS_FILE ?? path.join(os.homedir(), ".config", "jarvis", "secrets.json");
}

// cipher: { available(): bool, encrypt(string): Buffer, decrypt(Buffer): string }
export function createSecrets(cipher, file = secretsPath()) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
  };
  const write = (data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  };
  return {
    available: () => !!cipher?.available(),
    set(name, value) {
      if (!cipher?.available()) throw new Error("secure storage is not available on this machine; refusing to save a secret in plain text");
      const data = read();
      if (value == null || value === "") delete data[name];
      else data[name] = cipher.encrypt(String(value)).toString("base64");
      write(data);
    },
    get(name) {
      const v = read()[name];
      if (!v || !cipher?.available()) return null;
      try { return cipher.decrypt(Buffer.from(v, "base64")); } catch { return null; }
    },
    has: (name) => !!read()[name],
    remove(name) { const d = read(); delete d[name]; write(d); },
  };
}
