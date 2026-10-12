<div align="center">

<img src="q0/0logov3.png" alt="BOLTEVM" width="180" />

# DarkCircle Suite

**Private payments, AMM liquidity and multi-sig custody on Quai Network, behind one 3D portal.**

<br />

![Quai Network](https://img.shields.io/badge/Quai-Cyprus--1_%C2%B7_chain_9-ff3b30?style=for-the-badge&labelColor=0a0e16)
![Status](https://img.shields.io/badge/status-pre--release-f59e0b?style=for-the-badge&labelColor=0a0e16)
![three.js](https://img.shields.io/badge/three.js-r160_vendored-06b6d4?style=for-the-badge&labelColor=0a0e16)
![Blender](https://img.shields.io/badge/Blender-5.x_procedural-a855f7?style=for-the-badge&labelColor=0a0e16)

<br />

[The portal](#the-portal) &nbsp;·&nbsp; [The three apps](#the-three-apps) &nbsp;·&nbsp; [Build and run](#build-and-run) &nbsp;·&nbsp; [Deployment](#deployment) &nbsp;·&nbsp; [Quality gates](#quality-gates) &nbsp;·&nbsp; [Known limitations](#known-limitations)

<br />

<img src="assets/3d/qrb_chamber_preview.jpg" alt="Blender render of the QRB containment chamber: a dark orb ringed by crimson plasma in an octagonal vault with red light bars" width="860" />

<sub>The QRB containment chamber, rendered from <code>assets/3d/qrb_chamber.blend</code>. It is rebuilt from code by <code>tools/build_qrb_scene.py</code>.</sub>

</div>

---

## The portal

`index.html` is a real-time WebGL front door to the suite. A black obsidian orb hovers inside a crimson-lit octagonal containment vault, wrapped in a ring of plasma. The orb is the **Circleswap** node; **DarkCircle** and **DarkSafe** float to either side. Hover one to read it, click it (or press its number) to warp into the app.

| Input | Action |
|---|---|
| Drag | Orbit the chamber |
| Hover a node | Telemetry readout: node, route, live Cyprus-1 block height |
| Click a node / card / pill | Warp transition, then navigate |
| `1` `2` `3` | Warp to DarkCircle, Circleswap, DarkSafe |
| Sound button | Synthesized reactor hum and cues (Web Audio, muted by default) |
| Phone tilt | Parallax (iOS asks for permission on first touch) |
| `?mode=2d` | Force the 2D card portal |

**Graceful degradation.** No WebGL, a failed GPU context, a missing model file or `prefers-reduced-motion` all land on a working 2D portal or a calmer 3D one. The links are plain anchors, so navigation never depends on the 3D engine.

**Privacy.** The portal loads nothing from a third-party host: three.js and every add-on are vendored under `assets/3d/vendor/`, and there are no web fonts. The only network call is a single read-only `quai_blockNumber` to `rpc.quai.network`, made the first time you target a node, with credentials and referrer omitted. The bottom bar shows its state (`RPC idle`, `querying`, `CYPRUS-1 #...`).

### Subdomain and path routing

| Host starts with | Goes to |
|---|---|
| `q0.` `circleswap.` or contains `q0-` | `/q0/` |
| `darksafe.` `safe.` `multisig.` or contains `darksafe-` | `/multisigows/` |
| `tumbler.` `privacy.` `x402.` or contains `tumbler-` | `/x402tumbler/` |

`404.html` applies the same rules to deep links and keeps the `/<repo>/` prefix on GitHub project pages.

---

## The three apps

| | App | Route | What it is | Where it stands |
|---|---|---|---|---|
| 🛡️ | **DarkCircle**<br/>`x402tumbler/` | `/x402tumbler/` | x402 payment privacy on Quai: WQUAI and WQI shielded pools, PPOI compliance, ephemeral payees, a voice agent | Runs against an **in-memory simulation**. Nothing is deployed on Quai and no funds move. Circuit and pool contract are reference implementations, unaudited. The voice agent page is the one real-chain feature, and your wallet signs every step |
| ⚡ | **Circleswap**<br/>`q0/` | `/q0/` | Quai DeFi dashboard: pool analytics, swap math, LP, and a chain-driven Farms & Pools page with an owner admin dashboard for adding pairs | Reads live Cyprus-1 data. Transactions are signed by your own wallet extension. `SECURITY_AUDIT.md` is an internal, AI-assisted review and **not** an external audit |
| 🔐 | **DarkSafe**<br/>`multisigows/` | `/multisigows/` | DarkSafe multi-sig vaults: on-chain proposals, native timelock, quorum checks, no `DELEGATECALL` | Extension-only signing, no bundled signer. The vault contract has not had an independent security audit |

Each app has its own README with the details: [`x402tumbler/`](x402tumbler/README.md), [`q0/`](q0/README.md), [`multisigows/`](multisigows/README.md).

> **Treat everything here as pre-release.** Do not point any of it at funds you cannot afford to lose.

---

## Repository layout

```
.
├── index.html                  3D portal + subdomain router (single file, ASCII-only)
├── 404.html                    base-path-aware redirect for deep links and subdomains
├── 0.png  Boltfont.png         brand mark and "Powered by" wordmark (copied into each app)
├── assets/3d/
│   ├── qrb_chamber.glb         web asset (generated)
│   ├── qrb_chamber.blend       Blender source (generated)
│   ├── qrb_chamber_preview.jpg README hero render
│   └── vendor/three/           three.js r160 + the add-ons the portal uses (MIT)
├── tools/
│   ├── build_qrb_scene.py      procedural Blender builder  ->  .blend + .glb
│   ├── verify_qrb_assets.mjs   structural gate for the .glb
│   ├── assemble_site.sh        builds the Pages bundle (CI and local)
│   ├── check_legacy_name.sh    fails if the retired product name reappears
│   └── test_404_router.mjs     behavioural test for the redirect router
├── x402tumbler/                DarkCircle
├── q0/                         Circleswap
├── multisigows/                DarkSafe
└── .github/workflows/deploy-pages.yml
```

---

## Build and run

You need Node 22+, pnpm 10 and, only to regenerate the 3D asset, Blender 5.x.

**1. Build the apps** (the same commands CI runs):

```bash
(cd q0 && pnpm install --frozen-lockfile \
  && pnpm --filter quai-service build && pnpm --filter stats-app build)

(cd multisigows && pnpm install --frozen-lockfile \
  && pnpm --filter @darksafe/core build  && pnpm --filter @darksafe/ui build \
  && pnpm --filter @darksafe/verify build && pnpm --filter @darksafe/watcher build \
  && pnpm --filter @darksafe/web build)
```

**2. Assemble and serve the unified site:**

```bash
bash tools/assemble_site.sh _site
python -m http.server 8080 --directory _site     # then open http://localhost:8080
```

`assemble_site.sh` exits non-zero if any destination the portal links to is missing from the bundle.

**3. Regenerate the 3D scene** (optional; the committed `.glb` is what ships):

```bash
blender --background --python tools/build_qrb_scene.py
blender --background --python tools/build_qrb_scene.py -- --preview out.png --frame 30 --no-export
node tools/verify_qrb_assets.mjs
```

On Windows Blender lives at `C:\Program Files\Blender Foundation\Blender 5.2\blender.exe`.

### About the 3D asset

| | |
|---|---|
| Space | Y-up, metres. Orb centre at `(0, 1.7, 0)`, radius 0.5. Room: 14.8 m across, 4.6 m high |
| Size | about 24k triangles, 790 KB `.glb`, 10 PBR materials, no textures |
| Lights | 7 punctual lights, exported unitless (`COMPAT`) so three.js does not blow out |
| Animation | Four 5-second loop clips: orb hover, plasma spin, plasma sweep, camera push |
| Reference | Proportions and bar positions are measured from the QRB artwork `q0/QgoGIF.gif` (`ar://MbJXaZJwc0PjrCK2iwBblrR6m0aAYIUJ7xsIIpQpHQk`) |

---

## Deployment

`.github/workflows/deploy-pages.yml` runs on every push to `main`:

1. Verify the 3D asset, check portal sources are pure ASCII, test the redirect router, run the Circleswap unit tests
2. Refresh the Quainance launchpad snapshot (best effort), then build Circleswap and DarkSafe
3. `tools/assemble_site.sh _site`
4. Upload and deploy to GitHub Pages

`.github/workflows/ci.yml` runs on every push and pull request and is what says a change is safe: Circleswap (types, unit tests, bun tests, the contract suites, production build), DarkSafe (build, types, core / web / verifier / watcher tests) and the DarkCircle console (types and its 915 tests), each with a production dependency audit. DarkSafe's contract jobs (Slither, Foundry, coverage) are in `multisigows/.github/workflows/ci.yml` and run when that folder is its own repository.

The bundle contains `index.html`, `404.html`, the `.glb`, the vendored three.js, and each app's static build under its route (plus the `circleswap/`, `darksafe/` and `darkcircle/` aliases). The `.blend` is source and is not published.

---

## Quality gates

| Gate | Command | What it catches |
|---|---|---|
| Asset structure | `node tools/verify_qrb_assets.mjs` | Wrong up-axis, orb or room scale, lights exported in physical units, a light pointing the wrong way, an animation loop that stalls at the seam, unused UVs, triangle and size budgets |
| Token metadata | `node --test q0/packages/quai-service/test/tokenMetadata.test.ts` | Decoding of untrusted contract output, chain-first precedence (decimals never from the explorer, never defaulted to 0), icon-URL resolution, TTL and negative caching |
| Redirect router | `node tools/test_404_router.mjs` | Project-pages prefix loss, subdomain and deep-link redirects |
| Brand | `bash tools/check_legacy_name.sh` | The retired product name reappearing anywhere in tracked text (the multi-sig app is DarkSafe) |
| Portal encoding | CI step | Any non-ASCII byte in `index.html` or `404.html` (the first build shipped corrupted dashes and emoji) |
| Bundle integrity | `bash tools/assemble_site.sh` | A navigation target or vendored module missing from the deployed bundle |

---

## Known limitations

These are tracked, not hidden:

- **DarkCircle on static hosting.** Its UI expects the local API from `pnpm ui` in `x402tumbler/`. On Pages there is no server, so the page recognises that, shows a "Static preview" banner, switches its actions off and makes no API calls.
- **Circleswap on static hosting.** Neither the explorer's indexed stats nor Quainance's launchpad catalog send a CORS header, so the hosted page does not request them: USD values come from pool reserves, and Hartii / POOP / curve launches come from a snapshot taken at deploy time and labelled with its date. Token metadata is unaffected: it uses the CORS-open `/api/token/<address>` endpoint and the RPC.
- **Wallet extensions.** Every app treats an injected wallet as untrusted input: a provider that throws or lacks events is reported as absent rather than allowed to break the page, and Circleswap shows a crash screen with details instead of a blank page.
- **Portal metrics.** The hover readout shows the Cyprus-1 block height only. Pool TVL and vault status are not wired in.
- **No licence file yet.** Until one is added, reuse rights are unspecified. The vendored three.js keeps its MIT licence in `assets/3d/vendor/three/LICENSE`.

---

<div align="center">

<img src="q0/0logov3.png" alt="" width="48" />

<sub>Built on **Quai Network** (Cyprus-1, chain id 9) &nbsp;·&nbsp; **BOLTEVM**</sub>

<a href="https://boltevm.com"><sub>Powered by</sub> <img src="Boltfont.png" alt="BOLT" height="18" /></a>

</div>
