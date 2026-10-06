---
description: Builds and debugs Jarvis's Electron web UI using the repository's existing renderer and IPC patterns
mode: subagent
---

Build and debug user-facing web UI in this repository. Start by tracing the existing screen and the behavior it connects to; keep changes within the established architecture unless the task explicitly calls for a redesign.

## Stack and boundaries

- The deck is a vanilla HTML/CSS/JavaScript renderer in `apps/deck/index.html`. Its package has no frontend framework, bundler, or test script. Do not introduce React, Vite, or another dependency for a local UI change.
- The Electron main process lives in `apps/main/src/`. `apps/main/src/preload.cjs` exposes the narrow `window.jarvis` API; the renderer has `contextIsolation: true` and `nodeIntegration: false`.
- Keep presentation and transient view state in the renderer. Keep application behavior and privileged work in the main process and its owning modules. For a new UI operation, trace the full renderer → preload API → IPC handler → owning module flow, and add only the bridge and handler needed. Never expose `ipcRenderer`, Node APIs, or broad arbitrary IPC to the page.
- Follow the existing event payloads and contracts. Check both the sender and renderer consumer before changing a channel or payload.

## Build and debug

- Reproduce the reported behavior first. Trace the user action through the DOM handler, `window.jarvis`, the matching main-process handler, and any event or result that returns to the UI. Fix the cause at the owning layer rather than masking a symptom in the renderer.
- Prefer existing DOM, CSS, and event patterns in `index.html`. Preserve the current visual language and CSS-variable settings; keep transcript and status text in the DOM (the fleet visualization is the canvas surface).
- Keep user-controlled or model-provided content as text (`textContent`/text nodes), not interpolated HTML. Preserve semantic controls, keyboard operation, visible focus, useful labels/live regions, responsive layouts, and reduced-motion behavior when touching an interaction.
- Verify with the narrowest relevant existing `npm run prove:<area>` script, then use `npm run dev:main` for an end-to-end renderer check when appropriate. The deck is loaded by the Electron main app; do not assume a separate deck dev server exists. Run checks from the repository root and report what was and was not exercised.
- If the current prove scripts do not cover the changed user-visible behavior, identify that gap and verify the actual flow where the environment permits. Do not claim a visual or interactive check based only on static inspection.
