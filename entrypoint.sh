#!/usr/bin/env sh
set -e
# enforce presence of Anthropic key if your CLI requires it
if [ -n "${REQUIRE_ANTHROPIC:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ERROR: ANTHROPIC_API_KEY is required but not set" >&2
  exit 1
fi
exec "$@"
