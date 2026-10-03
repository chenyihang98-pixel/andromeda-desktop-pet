# Andromeda: continuation brief for Codex

## Scope and starting point

Repository: https://github.com/chenyihang98-pixel/andromeda-desktop-pet

Continue from the latest `main`, which already includes the unpublished Windows fixes in commit `537f706882903d05623df8adf065132405d8b97b`. The downloadable `v0.2.0` release remains at `ff316368f6c100c8489940dec0cf3275816a7b2a` and does not include those fixes. The package version is still `0.2.0`; a local build of `main` is not the original release artifact. Before editing, resolve `main` and the tag again, record their exact SHAs, and inspect intervening changes. See the release's `SHA256SUMS.txt` for original artifact identities. Keep earlier tags and assets intact. The release's attached English handoff is a historical snapshot; this source document is the current continuation guide.

The fullscreen continuation began at `1dc3607f9c896eb0711abff0226e39b89f919f80` (the owner's concise documentation revision). Current source includes experimental Windows fullscreen auto-hide; no binary release contains it yet. Its validation record identifies the pre-commit source baseline and file hashes. Preserve the owner's revised prose and inspect tracked and untracked changes before continuing. The local modified build still reports `0.2.0` and differs from the published v0.2.0 artifact.

The owner requested practical evolution of known limitations, especially: drag the pet to an edge, tuck it away behind a small hover handle, reveal on hover, retract after leaving, and drag back out. Keep the calm stationary default and original art. Work only in this repository. Public visibility is not an open-source license: retain `UNLICENSED` and `NOTICE.md` unless the owner separately authorizes a change.

## Implemented in the original v0.2.0 release

- Four work-area edges, 18 DIP release threshold, actual compact handle geometry, hover reveal, 700 ms departure delay, re-entry cancellation, drag undocking, keyboard/tray/reset recovery
- No automatic docking during a cross-monitor drag or on pointer cancellation, blur, lost capture, or timeout
- DIP-only geometry, negative display coordinates, work-area/display changes, and removal recovery
- Separate lock and suspend reasons; preserve explicit user hiding; resume without taking focus
- Opt-in whole-window click-through; usable tray required; disabled while docked and on every restart; tray restore exits click-through
- Opt-in global pointer-direction gaze, approximately 10 Hz, no history or network transmission; manual animation and reduced-motion safeguards
- Fixed official release-page button, no background update downloading or execution
- Chinese/English-only Electron locale resources and maximum ZIP compression; normal runtime safety and license files retained
- Windows executable icon/version resource editing without code signing

Read `README.md`, `docs/ARCHITECTURE.md`, and `docs/TESTING.md` before changing behavior. The original atlas SHA-256 remains `8007f0c1c212ec2c950a92af4c8648d6eab66b61e7d998b702e452b3e7b1040d`.

## Windows fixes in main (not in published downloads)

- Read the OS's actual compact-window size and fit it back into the target work area; fix right/bottom overflow caused by Windows minimum sizes and fill the handle to the actual window
- Cancel dragging immediately when the native menu opens and reject new drags until it closes
- Bind dragging to the initiating `pointerId` and release capture during cleanup
- Restore the configured full pet size after undocking from a constrained work area
- Make renderer checks compatible with LF/CRLF and discover installed Chrome/Edge/Chromium for sandboxed browser tests

These are source changes, not a new binary release. Read `docs/WINDOWS-QA-2026-10-03.md` and the saved geometry evidence before repeating the diagnosis.

## Verification boundary

The owner confirmed v0.1.0 on their Windows computer. That does **not** verify v0.2.0. The original release build/test machine was Linux. A subsequent Windows 11 continuation is recorded in `docs/WINDOWS-QA-2026-10-03.md`, including exact baseline refs, changes now committed to `main`, automated checks, and limited native observations. It recorded 125 automated tests, 58 browser assertions with the sandbox enabled, and 12 native geometry checks on one display at 200% scale; the dependency audit found 0 known vulnerabilities on 2026-10-03. Those results apply to the post-release source, not to the downloadable ZIP. Unit and Electron/renderer adapter tests are useful regression evidence, not native Windows mouse routing, compositor, tray, lock, RDP, or mixed-DPI proof. Exact automated results and browser-test limitations are recorded in `docs/TESTING.md`. Do not turn a mock pass, cross-build, or screenshot into a native Windows QA claim. Priority 1 remains incomplete until the outstanding native matrix is exercised.

## Priority 1: native Windows validation and fixes

Files: `src/main.cjs`, `src/docking.cjs`, `src/pet.mjs`, `src/pet.css`, `tests/main.test.cjs`, `tests/docking.test.cjs`, `tests/renderer.test.mjs`.

The original release ZIP is useful as a regression baseline but predates the fixes above. To validate current source, use an authorized fresh build of the latest `main`, record the source SHA and artifact hash, and do not replace the existing release or reuse its checksum. Run that build on Windows 10/11 x64. Exercise the entire checklist in `docs/TESTING.md`, especially four edges/corners, taskbars on different sides, 100/125/150/200% scale, mixed-DPI displays with negative coordinates, monitor unplugging while tucked away, RDP reconnect, overlapping lock/sleep events, and shutdown while timers are pending. Verify the OS permits the compact handle bounds and that cursor capture remains valid while resizing/moving. Record OS/build, topology, DPI, observed result, and exact commit.

Acceptance: no stranded/invisible pet; no unexpected global click interception; no focus stealing on hover/unlock; no ghost input rectangle on an adjacent monitor; every entry state has a reliable tray/reset recovery route. Add focused regression tests for defects before marking the matrix verified. Never disable OS security to run the program.

## Priority 2: validate the Windows fullscreen experiment

Electron `enter-full-screen` only concerns an Electron window, not arbitrary applications. Do not use it as global detection. Do not claim a maximized window or desktop is fullscreen just because its size looks similar.

The current source implements a default-off Windows option using first-party `native/windows-fullscreen.cs` and `src/fullscreen-monitor.cjs`, without additional third-party packages. A usable tray and bundled helper are required. The helper samples only the foreground top-level window every 500 ms. Window, visible frame and client bounds must match the monitor within a 2-physical-pixel tolerance. It conservatively excludes ordinary maximized, minimized, invisible, cloaked, decorated, child, owned, tool, non-activating, shell/desktop and own-process windows. These rules can miss games or players; background fullscreen applications are outside its scope. Do not broaden the rules merely to make a synthetic fixture pass.

The helper requests Per-Monitor V2 DPI awareness and returns only a versioned fullscreen status and physical monitor rectangle. Main converts the monitor center with `screen.screenToDipPoint` and suppresses only on the pet's display. It does not read window titles, content or executable paths, take screenshots, log detection history, access the network or request administrator privileges. The supervisor launches a fixed path with separate arguments, `shell:false` and `windowsHide:true`; validates bounded newline JSON; and fails open on malformed output, exit or a 3-second heartbeat timeout, disabling the setting without a respawn loop.

`fullscreen` is an independent suppression reason alongside `locked` and `suspended`. Lock/suspend stops the helper. Restoration preserves manual-hidden state and uses `showInactive`. Explicit tray restore, reset, second-instance activation and manual actions disable fullscreen auto-hide; opening settings while fullscreen-suppressed also disables it. Tray loss must restore a recovery route. Test ordering and cleanup rather than treating helper policy fixtures as OS proof.

Build source: `scripts/build-windows-helper.cjs`, `scripts/before-pack.cjs`, and `native/windows-fullscreen.manifest`. Windows development `npm start` compiles the helper using the inbox .NET Framework 4 C# compiler; a Windows package build recompiles it and includes it through `extraResources` at `resources/native/windows-fullscreen.exe`. Execution uses the system .NET Framework runtime. The installed app never downloads or compiles the helper. Current helper builds support Windows x64 only, and Windows cross-builds from Linux explicitly fail. Non-Windows development skips the helper and disables this feature.

Native fullscreen windows can retain `WS_MAXIMIZE` / `IsZoomed`; never exclude them on that flag alone. Caption/frame styles and all three full-monitor rectangles distinguish ordinary maximized windows. A controlled Electron fixture exposed this case; see `docs/FULLSCREEN-QA-2026-10-04.md` for the narrow validation scope.

Acceptance remains incomplete: test borderless and exclusive games, video players, maximized ordinary windows, task switcher, desktop, secondary-screen fullscreen, mixed DPI, UAC secure desktop, lock/suspend overlap and RDP; measure overhead and record false positives/negatives. Automated, browser, helper-policy and limited native probe results must be reported separately from complete native acceptance. Keep the option off by default until verified. Ask for owner approval before adding material dependencies or broadening platform/security scope.

## Priority 3: signing and update distribution (not solved by source code)

Files: `package.json` build configuration, release process, `src/main.cjs` fixed release-page entry.

Windows SmartScreen can still warn. The owner must choose a signing service/certificate, provide publisher identity, approve cost/agreements, and configure secrets securely outside source/chat. Do not create or use credentials, purchase certificates, sign up for services, or change repository secrets without authorization. Signing can improve trust; it cannot promise the absence of reputation warnings.

True automatic updating needs a supported signed installer/update feed rather than assuming the current portable ZIP is suitable. Design opt-in behavior, authenticated/integrity-checked artifacts, update-signing keys as appropriate, rollback/recovery, interrupted-download tests, and release compatibility. Preserve the current manual update path until validated. Never execute an unsigned arbitrary download or use a checksum shipped beside a compromised download as the sole trust root. Keep user settings in the existing profile.

Acceptance: documented trust and rollback model, secure credential handling, approved publisher/terms/costs, successful fresh-install and upgrade tests on Windows, no silent data loss. No new CI executions or paid services without the owner's authorization.

## Priority 4: additional architectures/platforms (not shipped/validated)

Windows ARM64 is the narrowest additional build candidate, but needs a real device test. macOS requires transparent-window, tray, focus, cursor, power-event and signing/notarization work. Linux X11 and Wayland differ materially: Electron global cursor/position support is limited on Wayland. Do not simply publish another target and label it supported.

Make capabilities explicit and disable unsupported features with useful UI. Keep signing/notarization credentials out of source. Test each target independently; preserve Windows behavior. Only advertise actual built and native-tested packages, with known limitations.

## Priority 5: size and hit testing

Electron still dominates package size after locale trimming. Measure release ZIP and unpacked size and startup/RAM on real Windows. Evaluate whether a WebView2/native-shell/Tauri migration genuinely retains transparency, tray, power events, DPI, and offline deployment without shifting complexity to missing system runtimes. Do not delete GPU, ICU, security, or license files blindly or silently replace the UI framework in a small feature patch.

Current click-through affects the whole window, not transparent pixels. Pixel-aware hit testing would need a stable sprite alpha mask, scaled canvas geometry, toolbar/handle exceptions, mouse-routing verification, and fail-open recovery. Test animated sprite silhouettes and mixed DPI; do not make hover-dependent click-through toggle loops that trap the cursor or make controls unreachable.

Treat sprite hit testing as the next separate feature after the fullscreen work is reviewed. A conservative union alpha mask is a possible Windows prototype: Electron `setShape` clips both rendering and input, so preserve animated silhouettes and controls, and disclose that a union is not exact current-frame transparency. It has not been implemented here. Keep signing/automatic updates dependent on the owner's publisher and trust-model choices, other platforms dependent on appropriate hardware validation, and any lightweight shell migration as a separate measured prototype.

## Working and release checklist

```sh
npm ci
npm run verify
npm audit
npm run test:ui
npm run build:win
npm run pack:assets
```

`test:ui` requires a permitted local HTTP server and supported Chromium. Do not work around denied sandbox/browser access. Use a suitable authorized environment instead, or state the limit.

Run `build:win` on Windows with the .NET Framework compiler/runtime available. Record the helper's policy self-tests separately from real foreground-window observations. For uncommitted source, identify the base SHA plus the actual working diff/source hashes; a base commit alone does not identify the modified build. Do not publish a ZIP, move tags, or replace v0.2.0 assets as part of this local feature work.

Before publishing: verify final ASAR source against the exact remote commit, inspect ZIP contents and Electron licenses, verify the untouched atlas hash, run aggregate checks after the last source edit, record SHA-256 for all assets, and retain earlier releases. Release only inside this repository under the owner's current authorization. Do not widen permissions, grant a license, create paid infrastructure, or contact third parties autonomously. Include implemented changes, remaining limitations, and precise test evidence in release notes.
