#!/bin/sh
# Collects the runtime files of one app into an output tree (used by infra/docker/Dockerfile):
# compiled dist/ of the app and of every workspace package that was built, plus the SQL
# migrations of @ecloud/db. Source maps, declaration files and build info are dropped.
set -eu
app_dir="$1"
out="$2"
mkdir -p "$out"
for dir in packages/* "$app_dir"; do
  [ -d "$dir/dist" ] || continue
  mkdir -p "$out/$dir"
  cp -R "$dir/dist" "$out/$dir/dist"
done
if [ -d "$out/packages/db" ]; then
  cp -R packages/db/migrations "$out/packages/db/migrations"
fi
find "$out" \( -name '*.map' -o -name '*.d.ts' -o -name '*.tsbuildinfo' -o -name '*.test.js' \) -delete
