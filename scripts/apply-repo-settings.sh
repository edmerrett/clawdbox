#!/bin/bash
# Apply the repository's protection and security settings on GitHub. Run it once (and again after
# editing .github/rulesets/); it is idempotent. Needs the GitHub CLI, signed in as a repository admin:
#   brew install gh && gh auth login
#   scripts/apply-repo-settings.sh [owner/repo]
#
# What it sets:
#   - rulesets from .github/rulesets/: main only changes through squash-merged PRs with green CI and
#     CodeQL, no force-push or deletion; v* release tags can only be created, moved or deleted by admins
#   - squash merges only, branches deleted after merge
#   - Dependabot alerts and security updates, secret scanning with push protection, private
#     vulnerability reporting
#   - Actions: workflow tokens read-only by default, and workflows cannot approve PRs
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${1:-edmerrett/clawdbox}"
command -v gh >/dev/null || { echo "install the GitHub CLI first: brew install gh && gh auth login" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "sign in first: gh auth login" >&2; exit 1; }
say() { echo "• $*"; }

for file in .github/rulesets/*.json; do
  name=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$file")
  id=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$name\") | .id" | head -1)
  if [ -n "$id" ]; then
    gh api -X PUT "repos/$REPO/rulesets/$id" --input "$file" >/dev/null
    say "ruleset \"$name\" updated"
  else
    gh api -X POST "repos/$REPO/rulesets" --input "$file" >/dev/null
    say "ruleset \"$name\" created"
  fi
done

gh api -X PATCH "repos/$REPO" --input - >/dev/null <<'JSON'
{
  "allow_squash_merge": true,
  "allow_merge_commit": false,
  "allow_rebase_merge": false,
  "squash_merge_commit_title": "PR_TITLE",
  "squash_merge_commit_message": "PR_BODY",
  "delete_branch_on_merge": true,
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
JSON
say "merges: squash only; branches deleted after merge; secret scanning and push protection on"

gh api -X PUT "repos/$REPO/vulnerability-alerts" >/dev/null && say "Dependabot alerts on"
gh api -X PUT "repos/$REPO/automated-security-fixes" >/dev/null && say "Dependabot security updates on"
gh api -X PUT "repos/$REPO/private-vulnerability-reporting" >/dev/null && say "private vulnerability reporting on"
gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -F can_approve_pull_request_reviews=false -f default_workflow_permissions=read >/dev/null
say "Actions: read-only workflow tokens by default; workflows cannot approve PRs"
echo "done. Review them at https://github.com/$REPO/settings/rules"
