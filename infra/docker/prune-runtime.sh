#!/bin/sh
# Tidies an assembled runtime tree (used by infra/docker/Dockerfile, run in /src):
# - removes workspace directories that were not built (no dist/): their manifests were only
#   needed for `npm ci` against the root lockfile, not at run time;
# - removes node_modules/@ecloud/* links that would dangle after that (e.g. dev-only
#   @ecloud/testing);
# - removes source maps shipped inside third-party packages.
# Module resolution is unaffected: every remaining @ecloud/* link points at a built workspace.
set -eu
for dir in packages/* apps/* tests; do
  [ -d "$dir" ] || continue
  [ -d "$dir/dist" ] || rm -rf "$dir"
done
for link in node_modules/@ecloud/*; do
  [ -L "$link" ] || continue
  [ -e "$link" ] || rm -f "$link"
done
find node_modules -type f -name '*.map' -delete
