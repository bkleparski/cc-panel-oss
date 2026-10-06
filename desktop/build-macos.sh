#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
fail() { echo "CC Panel: $*" >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || fail 'Budowanie wymaga macOS. Na Linuxie nie buduj binarki macOS.'
xcode-select -p >/dev/null 2>&1 || fail 'Brak Xcode Command Line Tools: uruchom xcode-select --install, dokończ instalację i ponów.'
xcrun --find clang >/dev/null 2>&1 || fail 'Brak clang/SDK. Sprawdź instalację Command Line Tools.'
for tool in rustup cargo rustc rustfmt node npm codesign; do
  command -v "$tool" >/dev/null 2>&1 || fail "Brak $tool. Wymagane: rustup (Rust >=1.90), Node.js >=20 i npm. Zainstaluj je samodzielnie; szczegóły w docs/DESKTOP.md."
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || fail 'Wymagany Node.js >=20.'
rust_version=$(rustc --version | awk '{print $2}')
IFS=. read -r rust_major rust_minor rust_patch <<< "$rust_version"
[[ "$rust_major" -gt 1 || ( "$rust_major" -eq 1 && "$rust_minor" -ge 90 ) ]] || fail "Wymagany Rust >=1.90, jest $rust_version; rustup update stable."
# ~/Projekty idzie Syncthingiem: kilka GB target/ trzymamy poza nim (Cargo i Tauri CLI czytają CARGO_TARGET_DIR).
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/Library/Caches/cc-panel-desktop/target}"
case "$CARGO_TARGET_DIR" in "$HOME/Projekty"|"$HOME/Projekty/"*) fail "CARGO_TARGET_DIR=$CARGO_TARGET_DIR leży w ~/Projekty (Syncthing). Ustaw katalog poza nim." ;; esac
mkdir -p "$CARGO_TARGET_DIR"
echo "Artefakty Cargo/Tauri: $CARGO_TARGET_DIR"
echo 'Pobieranie zależności npm/Cargo wymaga internetu. Budowanie dla architektury tego Maca, podpis ad-hoc.'
if [[ -f package-lock.json ]]; then npm ci; else npm install; fi
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri -- build --bundles app
bundle="$CARGO_TARGET_DIR/release/bundle/macos/CC Panel.app"
[[ -d "$bundle" ]] || fail "Brak oczekiwanej aplikacji: $bundle"
codesign --force --deep --sign - "$bundle"
codesign --verify --deep --strict "$bundle"
echo "Gotowe: $bundle"
# Red X only hides the window and a second instance hands over to the running one: end the old process first.
echo "Zakończ starą aplikację i podmień: pkill -f '/Applications/CC Panel.app/Contents/MacOS/'; rm -rf '/Applications/CC Panel.app' && ditto '$bundle' '/Applications/CC Panel.app' && open '/Applications/CC Panel.app'"
echo 'Pierwsze otwarcie: Prawy klik → Otwórz; szczegóły Gatekeeper w docs/DESKTOP.md.'
