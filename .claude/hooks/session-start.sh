#!/bin/bash
# SessionStart hook for Claude Code cloud sessions: install app dependencies so
# lint and tests run out of the box. No-op outside the cloud.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
	exit 0
fi

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

# Every top-level app with a lockfile (musiksparring/, ...). npm install rather
# than npm ci so the cached container's node_modules is reused. All output goes
# to stderr: SessionStart stdout is injected into Claude's context.
shopt -s nullglob
for lock in "$root"/*/package-lock.json; do
	app="$(dirname "$lock")"
	echo "session-start: npm install in ${app#"$root"/}" >&2
	(cd "$app" && npm install --no-audit --no-fund --loglevel=error) >&2
done

# The pinned Playwright expects a newer Chromium build than the container ships
# in /opt/pw-browsers; the smoke tests launch $PW_CHROMIUM when it is set.
chromium=/opt/pw-browsers/chromium
if [ -z "${PW_CHROMIUM:-}" ] && [ -x "$chromium" ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
	line="export PW_CHROMIUM=$chromium"
	grep -qsxF "$line" "$CLAUDE_ENV_FILE" || echo "$line" >> "$CLAUDE_ENV_FILE"
fi
