#!/usr/bin/env bash
# assemble_site.sh -- build the unified GitHub Pages bundle from already-built sub-apps.
#
#   bash tools/assemble_site.sh [out_dir]      (default: _site)
#
# One script for CI (.github/workflows/deploy-pages.yml) and for local runs, so what is tested
# locally is exactly what is deployed. It fails if any navigation target of the portal
# (index.html -> ./x402tumbler/ ./q0/ ./multisigows/ ./darkquestate/) would be a dead link.
set -euo pipefail

OUT="${1:-_site}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

rm -rf "$OUT"
mkdir -p "$OUT"

# portal shell
cp index.html 404.html "$OUT/"
if [ -f CNAME ]; then
  cp CNAME "$OUT/"
fi
cp 0.png Boltfont.png "$OUT/"
touch "$OUT/.nojekyll"

# 3D assets: the GLB and the vendored three.js only (the .blend is source, not a web asset)
mkdir -p "$OUT/assets/3d"
cp assets/3d/qrb_chamber.glb "$OUT/assets/3d/"
cp -r assets/3d/vendor "$OUT/assets/3d/vendor"

# background music: the portal autoplays whatever ./playlist/ lists (see PLAYLIST in index.html)
mkdir -p "$OUT/playlist"
cp -r playlist/. "$OUT/playlist/"

# DarkCircle tumbler UI (static)
mkdir -p "$OUT/x402tumbler" "$OUT/darkcircle"
cp -r x402tumbler/ui/. "$OUT/x402tumbler/"
cp -r x402tumbler/ui/. "$OUT/darkcircle/"

# Q0 / Circleswap dashboard (vite build, base './')
mkdir -p "$OUT/q0" "$OUT/circleswap"
cp -r q0/apps/stats-app/dist/. "$OUT/q0/"
cp -r q0/apps/stats-app/dist/. "$OUT/circleswap/"

# DarkSafe web vault (vite build, base './')
mkdir -p "$OUT/multisigows" "$OUT/darksafe"
cp -r multisigows/apps/web/dist/. "$OUT/multisigows/"
cp -r multisigows/apps/web/dist/. "$OUT/darksafe/"

# Dark Questate brokerage (vite build, base './', hash routes). One copy only: 404.html sends the
# questate/ alias here, so the folder name b6/ is never published.
mkdir -p "$OUT/darkquestate"
cp -r b6/apps/web/dist/. "$OUT/darkquestate/"

# DarkOrder Grand Guild Halls (vite build, base './', hash routes). One copy only: 404.html sends
# the guildhalls/ alias here, so the folder name d0/ is never published.
mkdir -p "$OUT/darkorder"
cp -r d0/apps/web/dist/. "$OUT/darkorder/"

# integrity: everything the portal links to or loads must exist in the bundle
missing=0
for f in index.html 404.html 0.png Boltfont.png \
         assets/3d/qrb_chamber.glb assets/3d/vendor/three/three.module.js \
         assets/3d/vendor/three/addons/controls/OrbitControls.js \
         assets/3d/vendor/three/addons/loaders/GLTFLoader.js \
         assets/3d/vendor/three/addons/postprocessing/EffectComposer.js \
         assets/3d/vendor/three/addons/postprocessing/OutputPass.js \
         playlist/Wonfiddyshowcase.mp3 \
         q0/0logov3.png q0/Boltfont.png x402tumbler/Boltfont.png multisigows/Boltfont.png \
         darkquestate/0.png darkquestate/Boltfont.png darkorder/0.png darkorder/Boltfont.png \
         x402tumbler/index.html q0/index.html multisigows/index.html darkquestate/index.html \
         darkcircle/index.html circleswap/index.html darksafe/index.html darkorder/index.html; do
  if [ ! -f "$OUT/$f" ]; then
    echo "MISSING in bundle: $f" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "assemble_site: bundle is incomplete" >&2
  exit 1
fi
echo "assemble_site: $OUT ok ($(find "$OUT" -type f | wc -l) files)"
