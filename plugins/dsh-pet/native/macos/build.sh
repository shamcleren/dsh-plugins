#!/usr/bin/env bash
# Build the macOS pet Helper into lib/helper/darwin/desktop-pet-helper.app.
# The plugin (src/index.ts) spawns this bundle's inner binary over stdio.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="desktop-pet-helper"
OUT_DIR="$(cd ../../ && pwd)/lib/helper/darwin/${APP_NAME}.app"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "${BUILD_DIR}"' EXIT

SOURCES=(
  Sources/Atlas.swift
  Sources/Animation.swift
  Sources/Protocol.swift
  Sources/PetView.swift
  Sources/PetController.swift
  Sources/main.swift
)

mkdir -p "${OUT_DIR}/Contents/MacOS" "${OUT_DIR}/Contents/Resources"
cp Info.plist "${OUT_DIR}/Contents/Info.plist"

for arch in arm64 x86_64; do
  xcrun swiftc \
    -target "${arch}-apple-macos12.0" \
    "${SOURCES[@]}" \
    -o "${BUILD_DIR}/${APP_NAME}-${arch}" \
    -framework AppKit
done

xcrun lipo -create \
  "${BUILD_DIR}/${APP_NAME}-arm64" \
  "${BUILD_DIR}/${APP_NAME}-x86_64" \
  -output "${OUT_DIR}/Contents/MacOS/${APP_NAME}"

# Bind the universal executable and Info.plist into one internally consistent
# app bundle. Distribution notarization can replace this ad-hoc signature.
codesign --force --deep --sign - "${OUT_DIR}"

echo "built ${OUT_DIR}/Contents/MacOS/${APP_NAME}"
