// Noticing calls (docs/MEETING-MODE.md, Phase 6). `parakeet --watch-calls`
// reports which apps are using the microphone; this decides when that is a
// call starting or ending. Jarvis only ever OFFERS meeting mode: it never
// starts (or stops) recording on its own. Pure; Main runs the watcher.

// Call apps by bundle-id prefix. `tap` is what meeting mode records (the
// deck's call-app choice); browsers are listed because Meet runs in one.
export const CALL_APPS = [
  { prefix: "com.microsoft.teams", name: "Teams", tap: "com.microsoft.teams2" },
  { prefix: "us.zoom.", name: "Zoom", tap: "us.zoom.xos" },
  { prefix: "net.whatsapp.", name: "WhatsApp", tap: "net.whatsapp.WhatsApp" },
  { prefix: "com.apple.FaceTime", name: "FaceTime", tap: "" },
  { prefix: "com.cisco.webex", name: "Webex", tap: "" },
  { prefix: "Cisco-Systems.Spark", name: "Webex", tap: "" },
  { prefix: "com.tinyspeck.slackmacgap", name: "Slack", tap: "" },
  { prefix: "com.google.Chrome", name: "Chrome", tap: "com.google.Chrome", browser: true },
  { prefix: "com.apple.Safari", name: "Safari", tap: "", browser: true },
  { prefix: "com.apple.WebKit", name: "Safari", tap: "", browser: true },
  { prefix: "company.thebrowser.", name: "Arc", tap: "", browser: true },
  { prefix: "com.microsoft.edgemac", name: "Edge", tap: "", browser: true },
  { prefix: "com.brave.Browser", name: "Brave", tap: "", browser: true },
  { prefix: "org.mozilla.firefox", name: "Firefox", tap: "", browser: true },
];

// The call apps among the mic users, one entry per app (an app may hold the
// mic from several helper processes).
export function callAppsIn(inputs = []) {
  const out = new Map();
  for (const i of inputs) {
    const app = CALL_APPS.find((a) => String(i.bundle ?? "").startsWith(a.prefix));
    if (app && !out.has(app.name)) out.set(app.name, { name: app.name, tap: app.tap, browser: !!app.browser });
  }
  return [...out.values()];
}

export const initialCallState = () => ({ present: [], snoozed: [] });

// One watcher report -> the next state and at most one offer:
//   { start: app }  a call app started using the mic, no meeting is running,
//                   you have not said "not now" to it during this call;
//   { stop: app }   the app a running meeting was offered for stopped using
//                   the mic (the call ended).
// "Not now" (snooze) lasts until that app lets go of the mic.
export function callStep(state, inputs, { meetingActive = false, meetingApp = null, enabled = true } = {}) {
  const now = callAppsIn(inputs);
  const names = now.map((a) => a.name);
  const started = now.filter((a) => !state.present.includes(a.name));
  const ended = state.present.filter((n) => !names.includes(n));
  const next = { present: names, snoozed: state.snoozed.filter((n) => names.includes(n)) };
  if (meetingActive && meetingApp && ended.includes(meetingApp)) return { state: next, stop: { name: meetingApp } };
  // A browser using the mic is often not a call: offer for it only when no real call app is.
  const candidates = started.filter((a) => !next.snoozed.includes(a.name)).sort((a, b) => Number(a.browser) - Number(b.browser));
  if (enabled && !meetingActive && candidates.length) return { state: next, start: candidates[0] };
  return { state: next };
}

export const snooze = (state, name) => ({ ...state, snoozed: [...new Set([...state.snoozed, name])] });
