#!/bin/bash
# Check that a release tag was signed by a trusted key before anything from it is installed.
#   scripts/verify-release.sh SIGNERS_FILE TAG
# Exit 0 when TAG is an annotated tag named TAG whose SSH signature verifies against a key in
# SIGNERS_FILE (ssh-keygen "allowed signers" format); exit 5 otherwise, saying why.
set -euo pipefail
SIGNERS="${1:?usage: verify-release.sh SIGNERS_FILE TAG}"
TAG="${2:?usage: verify-release.sh SIGNERS_FILE TAG}"
fail() { echo "refusing $TAG: $*" >&2; exit 5; }

grep -Eqv '^[[:space:]]*(#|$)' "$SIGNERS" 2>/dev/null || fail "no trusted release keys in $SIGNERS"
[ "$(git cat-file -t "refs/tags/$TAG" 2>/dev/null)" = tag ] || fail "it is not an annotated, signed tag"
# A signed tag object carries its own name; a ref pointing at another release's tag object is a replay.
NAMED=$(git cat-file -p "refs/tags/$TAG" | sed -n 's/^tag //p' | head -1)
[ "$NAMED" = "$TAG" ] || fail "the tag object is named '$NAMED', not '$TAG'"
KEYGEN=$(command -v ssh-keygen) || fail "ssh-keygen is not installed, so the signature cannot be checked"
# Pin the verifier: a user's gpg.ssh.program (e.g. a signing-only helper) must not decide this.
OUT=$(git -c gpg.format=ssh -c gpg.ssh.program="$KEYGEN" -c gpg.ssh.allowedSignersFile="$SIGNERS" \
  verify-tag "refs/tags/$TAG" 2>&1) || fail "${OUT:-signature did not verify}"
echo "$OUT" | grep -m1 '^Good'
