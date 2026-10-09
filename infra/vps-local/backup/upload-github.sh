#!/usr/bin/env bash
# =============================================================================================
#  Off-host copy of the ECLOUD backup sets to GitHub (DRAFT, NOT RUN).
#  docs/VPS_LOCAL_CHANGE_LIST.md LCL-BK-3. Called by scripts/backup/backup.sh (unchanged) as
#    BACKUP_UPLOAD=command  BACKUP_UPLOAD_COMMAND=/opt/ecloud/bin/upload-github.sh
#  i.e. `upload-github.sh <new-set-dir>`.
#
#  Target (owner decision 2026-10-09): the EXISTING private repository dannymagat/ecloud, branch
#  `vps-local`, an ORPHAN branch holding only age-encrypted backup sets (no code history).
#  - Every run builds ONE fresh orphan commit containing the newest BACKUP_GITHUB_KEEP (default 7)
#    complete sets found next to <new-set-dir> (the local BACKUP_DIR keeps
#    BACKUP_RETENTION_COUNT sets) and FORCE-pushes it to refs/heads/vps-local. The branch never
#    accumulates history; pruned sets become unreachable and are dropped by GitHub's GC. No
#    clone or fetch is needed on the host.
#  - Pushes ONLY *.age plus SHA256SUMS and manifest.json (metadata, no secrets); any other file
#    makes it refuse, and every *.age file must start with the age header: plaintext never
#    leaves the host. The age PRIVATE key never exists on this host.
#  - GitHub rejects files > 100 MB: files larger than BACKUP_GITHUB_SPLIT_MB (default 95) are
#    split into <name>.part000, .part001, ... and listed in <set>/PARTS.txt
#    (restore: `cat <name>.part* > <name>`, then `sha256sum -c SHA256SUMS`).
#  - Auth: a deploy key with WRITE access generated on this host (/root/.ssh/ecloud-backup-deploy,
#    root 0600); github.com host key pinned in a known_hosts file (no trust-on-first-use).
#    CAUTION: a write deploy key can push to ANY branch of dannymagat/ecloud. The script only
#    ever pushes the branch vps-local (allow-list), but a compromised host could use
#    the key directly: protect the code branches (branch protection / rulesets) or move backups
#    to a dedicated repository later (LCL-BK-3 owner item).
#
#  Config: /etc/ecloud/backup-github.env (root 0600, no secrets):
#    BACKUP_GITHUB_REPO=dannymagat/ecloud
#    BACKUP_GITHUB_BRANCH=vps-local
#    BACKUP_GITHUB_KEY=/root/.ssh/ecloud-backup-deploy
#    BACKUP_GITHUB_KNOWN_HOSTS=/etc/ecloud/github_known_hosts
#    BACKUP_GITHUB_KEEP=7
#    BACKUP_GITHUB_SPLIT_MB=95
#  Local test only: BACKUP_GITHUB_REMOTE=<path> is honoured ONLY together with
#  ECLOUD_UPLOAD_TEST=1 (validate-local.sh); otherwise it is ignored.
#  Staging happens on the backup filesystem (/data), never in /tmp; free space is checked first.
# =============================================================================================
set -euo pipefail
umask 077

CONF="${BACKUP_GITHUB_CONF:-/etc/ecloud/backup-github.env}"
# shellcheck disable=SC1090
if [ -f "$CONF" ]; then set -a; . "$CONF"; set +a; fi
KEY="${BACKUP_GITHUB_KEY:-/root/.ssh/ecloud-backup-deploy}"
KNOWN="${BACKUP_GITHUB_KNOWN_HOSTS:-/etc/ecloud/github_known_hosts}"
BRANCH="${BACKUP_GITHUB_BRANCH:-vps-local}"
KEEP="${BACKUP_GITHUB_KEEP:-7}"
SPLIT_MB="${BACKUP_GITHUB_SPLIT_MB:-95}"

die() {
  echo "upload-github: $*" >&2
  exit 1
}

SET="${1:-}"
[ -n "$SET" ] && [ -d "$SET" ] || die "usage: $0 <backup-set-dir>"
SET="$(cd "$SET" && pwd)"
ROOT="$(dirname "$SET")"
[[ "$(basename "$SET")" =~ ^20[0-9]{6}T[0-9]{6}Z$ ]] || die "not a backup set directory: $SET"
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_GITHUB_KEEP must be a positive integer"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || die "bad branch name"
# Allow-list: the backup branch and nothing else (owner decision 2026-10-09).
[ "$BRANCH" = vps-local ] || die "refusing to push backups to '$BRANCH' (only vps-local)"
command -v git >/dev/null || die "git is not installed (LCL-BK-1)"

if [ "${ECLOUD_UPLOAD_TEST:-}" = 1 ] && [ -n "${BACKUP_GITHUB_REMOTE:-}" ]; then
  REMOTE="$BACKUP_GITHUB_REMOTE"
else
  [[ "${BACKUP_GITHUB_REPO:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "BACKUP_GITHUB_REPO not set (owner/repo)"
  [ -f "$KEY" ] || die "deploy key missing: $KEY"
  [ -s "$KNOWN" ] || die "pinned known_hosts missing: $KNOWN"
  REMOTE="git@github.com:${BACKUP_GITHUB_REPO}.git"
  export GIT_SSH_COMMAND="ssh -F /dev/null -i $KEY -o IdentitiesOnly=yes -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile=$KNOWN -o StrictHostKeyChecking=yes -o BatchMode=yes"
fi

# --- 1. the newest KEEP complete sets (the new one included) -----------------------------------
mapfile -t sets < <(find "$ROOT" -maxdepth 1 -mindepth 1 -type d -name '20*T*Z' -exec basename {} \; | sort | tail -n "$KEEP")
printf '%s\n' "${sets[@]}" | grep -qx "$(basename "$SET")" || die "new set is not among the newest $KEEP"

# --- 2. allow-list + encryption check, stage (split large files) -------------------------------
# Stage next to the sets (on /data), never in /tmp: needs roughly the size of the kept sets.
need_kb=0
for s in "${sets[@]}"; do need_kb=$((need_kb + $(du -sk "$ROOT/$s" | cut -f1))); done
free_kb="$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')"
[ "$free_kb" -gt $((need_kb * 2 + 102400)) ] || die "not enough free space on $ROOT (${free_kb} KiB free, need ~$((need_kb * 2)) KiB)"
WORK="$(mktemp -d -p "$ROOT" .upload-github.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/tree"
limit=$((SPLIT_MB * 1024 * 1024))
for s in "${sets[@]}"; do
  n_age=0
  mkdir "$WORK/tree/$s"
  for f in "$ROOT/$s"/*; do
    b="$(basename "$f")"
    case "$b" in
      SHA256SUMS | manifest.json) ;;
      *.age)
        [ "$(head -c 21 "$f")" = "age-encryption.org/v1" ] || die "$s/$b does not start with the age header: refusing"
        n_age=$((n_age + 1))
        ;;
      *) die "unexpected file $s/$b (only *.age, SHA256SUMS, manifest.json are pushed)" ;;
    esac
    if [ "$(stat -c %s "$f")" -gt "$limit" ]; then
      split -b "${SPLIT_MB}M" -d -a 3 "$f" "$WORK/tree/$s/$b.part"
      echo "$b" >>"$WORK/tree/$s/PARTS.txt"
    else
      cp "$f" "$WORK/tree/$s/$b"
    fi
  done
  [ "$n_age" -ge 1 ] || die "no *.age file in set $s"
done
cat >"$WORK/tree/README.md" <<EOF
ECLOUD vps-local backup sets (age-encrypted, newest ${#sets[@]}). Force-pushed by
infra/vps-local/backup/upload-github.sh; restore: docs/RESTORE_DRILL.md (the age key is offline).
EOF

# --- 3. one orphan commit, force-pushed to the backup branch ----------------------------------
g() { git -C "$WORK/tree" -c user.name=ecloud-backup -c user.email=ecloud-backup@localhost "$@"; }
g init -q
g checkout -q --orphan "$BRANCH"
g add -A
g commit -q -m "ecloud backups: ${sets[*]}"
sha="$(g rev-parse HEAD)"
g push -q "$REMOTE" "+HEAD:refs/heads/$BRANCH"
remote_sha="$(g ls-remote "$REMOTE" "refs/heads/$BRANCH" | cut -f1)"
[ "$remote_sha" = "$sha" ] || die "verification failed: remote $BRANCH is '$remote_sha', expected $sha"
echo "upload-github: $BRANCH = $sha (${#sets[@]} sets, newest $(basename "$SET"))"
