#!/usr/bin/env bash
# Builds the Quark server the e2e tests run against: the Go backend only, with
# no web app embedded and no Flutter needed.
#
#   QUARK_SRC=/path/to/quark scripts/build-quark.sh [output]
#
# QUARK_WEB=1 also builds Quark's Flutter web app (release mode) and embeds it,
# for e2e/quark-login.spec.ts, which fills Quark's own /login. That needs
# Flutter, and takes several minutes. The app stays in the checkout's
# internal/server/public, so later builds embed it too until it is removed.
#
# QUARK_SRC is a checkout of github.com/autobutler-org/quark. The binary goes to
# e2e/.quark/quark unless an output path is given; that's where the e2e global
# setup looks for it when QUARK_BIN is unset. The checkout's go.mod names the
# Go version; GOTOOLCHAIN=auto lets an older Go fetch it.
set -euo pipefail

src="${QUARK_SRC:?Set QUARK_SRC to a checkout of github.com/autobutler-org/quark}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/e2e/.quark/quark}"
mkdir -p "$(dirname "$out")"

cd "$src"
# The server embeds internal/server/public; without the web app it holds only
# the stub `make build/backend` puts there.
mkdir -p internal/server/public
touch internal/server/public/stub.txt
if [ "${QUARK_WEB:-}" = 1 ]; then
  # What `make build/frontend/web` does, in release mode: the SBOM asset the
  # pubspec lists is generated, not committed.
  flutter pub get
  dart scripts/generate_flutter_sbom.dart
  flutter build web --release
  cp -R build/web/. internal/server/public/
fi
commit="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
GOTOOLCHAIN="${GOTOOLCHAIN:-auto}" go build \
  -ldflags "-X github.com/autobutler-org/quark/pkg/util/versionutil.GitCommit=$commit" \
  -o "$out" ./cmd/quark
echo "Built Quark $commit at $out"
