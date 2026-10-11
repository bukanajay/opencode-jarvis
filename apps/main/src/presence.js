// Always-on presence: Jarvis lives in the menu bar. Closing the deck window
// hides it; the brain, fleet, voice loop and routines keep running until you
// choose Quit. Also: native notifications while the deck is hidden, and an
// opt-in "start at login" (LaunchAgent in dev, login item when packaged).
import { app, Menu, Notification, Tray, nativeImage } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tray = null;
let quitting = false;
let hooks = {};
let inboxCount = 0;
let hiddenNoticeShown = false;

export const isQuitting = () => quitting;
export const startHidden = () => process.argv.includes("--hidden");

export function createPresence(h) {
  hooks = h;
  app.on("before-quit", () => { quitting = true; });
  app.on("activate", () => hooks.show?.());
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("Jarvis");
  paint();
  return { setInbox, notify, setLaunchAtLogin, wireWindow };
}

// The deck window hides instead of closing, so Jarvis keeps working.
export function wireWindow(win) {
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!hiddenNoticeShown) {
      hiddenNoticeShown = true;
      notify("Jarvis is still running", "Routines, the fleet and voice keep going. Use the J in the menu bar to reopen or quit.");
    }
  });
}

function paint() {
  if (!tray) return;
  tray.setTitle(inboxCount ? `J ${inboxCount}` : "J");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show Jarvis", click: () => hooks.show?.() },
    { label: "Brief me now", click: () => hooks.brief?.() },
    { label: inboxCount ? `Decision inbox (${inboxCount})` : "Decision inbox", click: () => hooks.openInbox?.() },
    { type: "separator" },
    { label: "Stand down (stop all workers, pause routines)", click: () => hooks.standDown?.() },
    { type: "separator" },
    { label: "Quit Jarvis", click: () => { quitting = true; app.quit(); } },
  ]));
}

export function setInbox(n) {
  inboxCount = n;
  paint();
  if (process.platform === "darwin") app.dock?.setBadge(n ? String(n) : "");
}

export function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: String(body ?? "").slice(0, 240), silent: false });
  n.on("click", () => { hooks.show?.(); onClick?.(); });
  n.show();
}

// Start at login. Packaged app: the OS login item. Dev (electron .): a user
// LaunchAgent that runs this same Electron + app path with --hidden and the
// current PATH (launchd's default PATH has no git/opencode/node).
export const LAUNCH_AGENT = path.join(os.homedir(), "Library", "LaunchAgents", "dev.jarvis.deck.plist");

export function launchAgentPlist({ electron, appPath, envPath }) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.jarvis.deck</string>
  <key>ProgramArguments</key>
  <array><string>${esc(electron)}</string><string>${esc(appPath)}</string><string>--hidden</string></array>
  <key>WorkingDirectory</key><string>${esc(appPath)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(envPath)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

export function setLaunchAtLogin(on) {
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true, args: ["--hidden"] });
    return { ok: true, via: "login item" };
  }
  if (process.platform !== "darwin") return { ok: false, reason: "start at login is macOS-only in dev" };
  if (on) {
    fs.mkdirSync(path.dirname(LAUNCH_AGENT), { recursive: true });
    fs.writeFileSync(LAUNCH_AGENT, launchAgentPlist({ electron: process.execPath, appPath: app.getAppPath(), envPath: process.env.PATH ?? "/usr/bin:/bin" }));
  } else {
    fs.rmSync(LAUNCH_AGENT, { force: true });
  }
  return { ok: true, via: "LaunchAgent", path: LAUNCH_AGENT };
}
