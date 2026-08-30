# Native Ops artifact evidence harness

This directory owns the real native evidence lane for the Ops artifact reader. It is separate from Playwright: Playwright validates renderer branches with a mock bridge, while this harness starts the isolated Hub fixture and the actual Tauri desktop process.

The runner:

- uses only loopback Hub and relay URLs;
- enables the debug-only fail-closed evidence offline mode before startup, forces Cargo/pnpm offline, disables STT/TTS/mesh fetches, managed-agent restore/spawn, the system process sweep/reaper, and periodic event publishing, and continuously rejects non-loopback process-group sockets;
- creates a unique development bundle identifier and a fresh temporary `HOME`, `XDG_*`, and `TMPDIR` for every viewport;
- seeds only a migration marker, so Buzz enters lost-identity recovery and the harness chooses **Continue in local Ops mode** without creating or importing a personal key;
- launches each Tauri/Vite tree in its own detached process group and terminates that exact group;
- drives the app through `/usr/local/bin/orca computer` by the Tauri PID;
- opens `evidence-summary.md` through the inline path and the deterministic `evidence-large.txt` fixture through the opaque native handle path, verifies both contents, and checks exact trigger focus restoration after both closes;
- verifies focus restoration, the app-owned handle directory, Hub zero-side-effect counters, and redacted logs;
- drains each child and its output streams before hashing logs;
- writes screenshots, accessibility trees, logs, `manifest.native.json`, and the cross-checked `manifest.md` under `docs/reports/img/ops-artifacts/`, plus the tested SHA-pair matrix at `docs/reports/ops-bridge-compatibility-matrix.md`.

Run unit contracts first:

```sh
cd desktop
pnpm test:native:ops-artifact-harness
```

Run the clean-worktree evidence gate on macOS with Orca Accessibility and Screen Recording permissions enabled:

```sh
cd desktop
pnpm test:native:ops-artifact
```

For a local development probe only, `--allow-dirty --viewport 390` may be appended. Evidence intended for review must use the default clean-worktree gate and all three approved viewports (`1280x900`, `736x900`, `390x844`). The runner never sends messages, executes providers, touches GitHub, pushes, merges, publishes, or deploys.
