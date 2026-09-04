# Changelog

All notable user-facing changes to `homebridge-petlibro-2` are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0] - 2026-09-04

Adds support for the PLAF109 "Polar" wet food feeder (Wave C of the device-expansion plan). Endpoints and behavior below were verified against live hardware (PLAF109, firmware 2.0.28) rather than inferred — including the finding that the tray-rotation endpoint is a relative step and that re-serving an already-served slot is permitted server-side.

### Fixed
- **PLAF109 manual feeding never worked.** The Polar was classified as a generic feeder, so taps posted the dry-feeder endpoint `/device/device/manualFeeding` with a `grainNum` portion count. The Polar's firmware does not implement that command: the API answered HTTP 200 with body `{"code": 2020, "msg": "Device response timeout"}` and nothing moved. Wet feeders now post `/device/wetFeedingPlan/manualFeedNow` with a `plate`.
- **Feed failures reported the HTTP status instead of the API error.** `triggerFeeding` only treated a non-200 HTTP status as failure, so a 200 carrying `code: 2020` fell through to `Feed command failed with status 200` — a message naming a success status and hiding the actual cause. Errors now read `Feed command failed: API code 2020 (Device response timeout)`. Success semantics are unchanged; only the error path gained detail.

### Added
- **`DEVICE_TYPE.WET_FEEDER` and the `PetLibroWetFeeder` class.** Detection keys on `productIdentifier === 'PLAF109'` with a `productName` containing "Polar" as fallback. Deliberately not serial-prefix based: Polar and Granary serials share the same `AF` family code, so a prefix check cannot separate them.
- **A momentary switch per tray** (`Tray 1` / `Tray 2` / `Tray 3`, subtypes `serve-N`) so a specific slot can be served directly. Stepping the tray blind and guessing where it landed was the only option otherwise, since the API exposes no absolute "go to tray N" call.
- **Standalone tray rotation as a Switch** (subtype `rotate`, labelled `Rotate Tray`). Momentary. Advances one slot without opening the lid — not reachable from the official app, which only rotates as a side effect of feeding.
- **`config.schema.json`**, which the repo previously lacked entirely. Every existing option (`email`, `password`, `country`, `timezone`, `portions`, `fountainPollingInterval`, `debugDeviceDump`, `apiEndpoint`) plus the three new ones are now editable in Config UI X instead of by hand-editing `config.json`. The default tray is a dropdown. Satisfies the constitution's "Configuration schema MUST be defined in `config.schema.json`" requirement.
- **`wetPlate` config** (integer 1-3, default 1) — the default tray: which slot the primary feed switch serves, and what Siri targets. Out-of-range and non-numeric values fall back to 1.
- **`exposeTraySwitches` config** (boolean, default true). When false, the per-tray switches are removed from the accessory, leaving just the feed and rotate switches.
- **`enableTrayRotation` config** (boolean, default true). When set false, an already-cached rotate service is removed from the accessory.
- **`setServiceName()` helper** setting both `Name` and `ConfiguredName`. Apple Home renders `ConfiguredName` on accessories carrying several services of the same type; setting only `Name` left every switch tile showing the same fallback label, with no way to tell them apart.
- **`setPlatePosition(target, current)`** for absolute positioning, built on the relative step primitive: `(target - current) mod 3` calls with a 600 ms cooldown between them, matching the upstream HA integration's pacing. The tray motor drops steps when calls are issued back to back.
- 20 test cases across `test/device-type.test.js` and the new `test/wet-feeder.test.js`, including a guard that every exposed switch carries a unique label.

### Changed
- **`assertApiOk` is now the shared response validator** for all device commands, replacing the inline check in `triggerFeeding`.
- **The primary (subtype-less) switch is labelled `Feed Tray N`**, reflecting the configured default, and delegates to the same `serveTray()` path as the per-tray switches.
- **`getDeviceType` test expectation inverted for PLAF109.** It previously asserted the Polar classified as a plain `FEEDER`; that assertion was pinning the bug.

### Upgrade note
The accessory UUID seed includes the device type, so a PLAF109 previously cached as `feeder` gets a new UUID as `wet_feeder`. **The old Polar accessory is unregistered and a new one appears**, which means a one-time room reassignment, rename, and re-add to any scenes or automations in Apple Home. Other devices are unaffected.

### Known limitation
`platePositionChange` advances the tray but does **not** open the lid; opening is `manualFeedNow`. There is no separate lid-open endpoint in the observed API surface. The plan object also exposes `enableFeedAgainWithThaw`, `feedAgainDuration`, and `feedAgainExecutionEndTime`, which appear to control scheduled re-serving; these are unmapped and untouched by this release.

## [1.5.2] - 2026-06-20

Detection refinement based on the first real-world serial-number data from a v1.5.1 production deployment. No user-visible behavior change for anyone whose devices currently classify correctly; closes a latent misclassification risk for devices whose `productName` lacks fountain keywords.

### Fixed
- **`getDeviceType` deviceSn-prefix check now matches real PetLibro serials.** Production captures show the API returns serials prefixed with a 2-char family code (`WF` for fountains, `AF` for feeders) — not the `PLWF`/`PLAF` marketing/product codes used in the README and on petlibro.com. The pre-1.5.2 `PLWF` check never fired on real data; classification worked only because the `productName` fallback caught "Dockstream"/"Fountain". `WF` is now added to the serial-prefix list (with `PLWF` kept defensively). Fountains that ever return an unfamiliar `productName` will still classify correctly via serial alone.

### Changed
- **Split `FOUNTAIN_IDENTIFIERS` into `FOUNTAIN_NAME_KEYWORDS` + `FOUNTAIN_SERIAL_PREFIXES`** so the 2-char `WF` deviceSn prefix doesn't false-positive against arbitrary product names containing the substring "WF".
- **Plan doc updated** (`docs/plans/2026-06-18-device-expansion.md` §5b) with the two confirmed real-world serial prefixes and a note that per-model identification (PLWF105 vs PLWF305 etc.) still needs more capture samples.

### Added
- 5 new test cases in `test/device-type.test.js` pinning the real-world `WF`/`AF` serial classification and a regression guard against 2-char substring false-positives.

## [1.5.1] - 2026-08-06

Hotfix release. The regional endpoint routing added in 1.5.0 was a speculative addition based on a guessed `api.eu.petlibro.com` URL that does not actually resolve (NXDOMAIN). Users whose `country` config value mapped to EU (DE, FR, GB, CH, IT, ES, NL, SE, …) hit `getaddrinfo ENOTFOUND api.eu.petlibro.com` and the plugin failed to discover devices.

### Fixed
- **`getaddrinfo ENOTFOUND api.eu.petlibro.com` on startup** for users with EU country codes. The plugin now always uses `api.us.petlibro.com` (which serves all regions — the official PetLibro mobile app uses the same backend regardless of where the user is). Reverts the `COUNTRY_TO_REGION` auto-routing introduced in 1.5.0.

### Removed
- `region` config field (was a no-op in practice after the EU endpoint failure; removed from Config UI X schema).
- `COUNTRY_TO_REGION` table.
- `API_REGIONS.EU` entry.

### Kept
- `apiEndpoint` config field still works as a full-URL override for any future PetLibro endpoint changes.

### Migration
Nothing to do. If you had `region` or `country` set in your config, they're now ignored — your config will keep working as-is, just routed to the US endpoint like the mobile app does.

## [1.5.0] - 2026-06-20

First release after a focused round of API hardening, fountain support, and test coverage. Carries over three patterns from the upstream Home Assistant integration ([jjjonesjr33/petlibro](https://github.com/jjjonesjr33/petlibro)) plus broader water-fountain coverage.

### Added
- **Water-fountain support** for Dockstream Smart Fountain (PLWF105), Dockstream RFID (PLWF305), Dockstream 2 Plug-In (PLWF106), and Dockstream 2 Cordless (PLWF116). Water level is surfaced as a `HumiditySensor` tile in Apple Home — the only HomeKit primitive that renders a visible % tile.
- **Offline detection.** Apple Home now shows **"Not Responding"** when PetLibro reports a device offline. Fountains track `realInfo.online` on every poll; feeders check `online` from `/device/device/list` before firing a feed command. Missing `online` field is treated as still-online so older firmware doesn't trigger spurious unreachable states.
- **Token persistence across Homebridge restarts.** The auth token is cached to `<storagePath>/petlibro-token-<sha256(email)>.json` with file mode `0600`. Mirrors the upstream HA integration. Motivated by PetLibro's one-active-session-per-account constraint: every fresh login kicks the mobile app out, so eliminating restart-driven logins keeps your phone app logged in. Per-email hashing supports multi-account installs; the email never appears in plaintext on disk.
- **`apiEndpoint` config override** for advanced users who need to point at a non-default base URL. *(Note: 1.5.0 also shipped a speculative `region: "EU"` field and country-to-region auto-routing, both reverted in 1.5.1 — see that entry.)*
- **`debugDeviceDump` config flag** — when set, logs the raw `/device/device/list` JSON so users with unsupported PetLibro models can paste payloads into the new [Unsupported Device issue template](https://github.com/TechPreacher/HomebridgeLibro2/issues/new?template=unsupported-device.md). Contains device metadata only; a test asserts the password never appears in any log channel.
- **48-test unit suite** via Node's built-in `node:test` runner. Zero new runtime or dev dependencies. `npm test` runs in <2s; requires Node ≥18 (the published plugin still runs on Node ≥14.18.1 per `engines`).
- **`CLAUDE.md`** with architecture notes for future contributors; **`docs/plans/2026-06-18-device-expansion.md`** cataloging the 11 PetLibro device families upstream supports and a phased plan for porting the remaining 9.

### Changed
- **Fountain water level moved from `Service.Battery` to `Service.HumiditySensor`.** The Battery service was invisible in Apple Home tiles (it only renders as a small badge on the device-details screen); HumiditySensor surfaces the live percentage on the main accessory tile. Mislabeled as "Humidity" in Apple Home but the value displayed *is* the water level. Existing fountain accessories auto-migrate on first restart.
- **`requestId` now uses `crypto.randomUUID()`** (RFC 4122 v4) instead of two stitched `Math.random()` slices. Matches the upstream `uuid.uuid4()` pattern.
- **README** rewritten: new sections for testing, regional config, unsupported-device reporting, and the water-fountain rationale.

### Fixed
- **PetLibro error code 1009 (NOT_YET_LOGIN)** — server-side token invalidations (commonly: another login on the same account) now trigger an automatic re-authenticate and one retry, via a new `apiPost` helper used by every authenticated request. Previously the plugin only re-authenticated on local timer expiry, so server-side invalidations caused silent failures until the timer elapsed.
- **`realInfo` payload missing `id` field.** Upstream `post_serial` sends both `id` and `deviceSn` for serial-keyed endpoints; we now match.

### Removed
- **`Authorization: Bearer` header on authenticated requests.** Upstream HA integration validates only the `token` header; the Bearer was dead weight.
- **`/member/auth/refresh` endpoint** — unverified and unused by upstream. We always re-authenticate via `/member/auth/login`.

### Breaking changes
None. Fountain accessories auto-migrate from `Battery` to `HumiditySensor` service on first restart (one bridge restart, no manual intervention).

## [1.3.0] - Initial fork release

Baseline of the `homebridge-petlibro-2` npm package. Forked from the now-abandoned [`praveensharma/HomebridgeLibro`](https://github.com/praveensharma/HomebridgeLibro) (npm: `homebridge-petlibro`) — the `-2` suffix in the name reflects independence: this is a separate npm package with its own release cadence and architecture decisions, not a maintained fork.

Initial fork-era functionality:
- Manual feeding via momentary `Switch` for PetLibro smart feeders (PLAF103, PLAF107, PLAF108, PLAF109, PLAF203, PLAF301).
- Multi-device discovery from a single PetLibro account.
- Config UI X integration via `configSchema`.

---

### Note on intermediate dev iterations

Versions `1.3.1`, `1.4.0`, and `1.4.1` existed as logical milestones during the development of 1.5.0 but were never published to npm. The changes from those milestones are rolled into the `1.5.0` entry above. Future releases will publish each version increment.

[1.5.2]: https://github.com/TechPreacher/HomebridgeLibro2/releases/tag/v1.5.2
[1.5.1]: https://github.com/TechPreacher/HomebridgeLibro2/releases/tag/v1.5.1
[1.5.0]: https://github.com/TechPreacher/HomebridgeLibro2/releases/tag/v1.5.0
[1.3.0]: https://github.com/TechPreacher/HomebridgeLibro2/releases/tag/v1.3.0
