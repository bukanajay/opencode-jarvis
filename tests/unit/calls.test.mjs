import { test } from "node:test";
import assert from "node:assert/strict";
import { callAppsIn, callStep, initialCallState, snooze } from "../../apps/main/src/calls.js";

const teams = [{ bundle: "com.microsoft.teams2", pid: 1 }, { bundle: "com.microsoft.teams2.helper", pid: 2 }];
const chrome = [{ bundle: "com.google.Chrome.helper", pid: 9 }];

test("callAppsIn: one entry per app, unknown apps ignored", () => {
  assert.deepEqual(callAppsIn([...teams, { bundle: "com.apple.VoiceMemos", pid: 3 }]), [{ name: "Teams", tap: "com.microsoft.teams2", browser: false }]);
  assert.deepEqual(callAppsIn(chrome).map((a) => [a.name, a.browser]), [["Chrome", true]]);
  assert.deepEqual(callAppsIn([]), []);
});

test("callStep: offers to start once per call, never while a meeting runs, never when turned off", () => {
  let s = initialCallState();
  let r = callStep(s, teams);
  assert.equal(r.start.name, "Teams");
  assert.equal(r.start.tap, "com.microsoft.teams2");
  s = r.state;
  assert.equal(callStep(s, teams).start, undefined, "same call, no second offer");
  assert.equal(callStep(initialCallState(), teams, { meetingActive: true }).start, undefined);
  assert.equal(callStep(initialCallState(), teams, { enabled: false }).start, undefined);
});

test("callStep: 'not now' lasts until that app lets go of the mic", () => {
  let s = callStep(initialCallState(), teams).state;
  s = snooze(s, "Teams");
  s = callStep(s, []).state; // call ended
  assert.deepEqual(s.snoozed, []);
  assert.equal(callStep(s, teams).start.name, "Teams", "the next call is offered again");
});

test("callStep: a real call app is offered before a browser; the meeting's app ending offers stop", () => {
  const r = callStep(initialCallState(), [...chrome, ...teams]);
  assert.equal(r.start.name, "Teams");
  let s = r.state;
  const stop = callStep(s, chrome, { meetingActive: true, meetingApp: "Teams" });
  assert.deepEqual(stop.stop, { name: "Teams" });
  assert.equal(callStep(s, chrome, { meetingActive: true, meetingApp: "Zoom" }).stop, undefined, "another app ending is not your call");
});
