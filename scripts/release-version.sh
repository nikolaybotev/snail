#!/usr/bin/env bash
# Decides the next release tag from git tags and the merged pull request labels.
# Prints "tag vMAJOR.MINOR.PATCH" or "noop". Exits non-zero on failure.
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "release: not inside a git repository" >&2
  exit 1
fi

semver_tag_re='^v[0-9]+\.[0-9]+\.[0-9]+$'

is_semver_tag() {
  [[ "$1" =~ $semver_tag_re ]]
}

head_semver_tag() {
  local t
  while IFS= read -r t; do
    [[ -n "$t" ]] || continue
    if is_semver_tag "$t"; then
      echo "$t"
      return 0
    fi
  done < <(git tag --points-at HEAD 2>/dev/null || true)
  return 1
}

if head_tag="$(head_semver_tag)"; then
  echo "noop"
  exit 0
fi

latest=""
any_semver=false
while IFS= read -r t; do
  [[ -n "$t" ]] || continue
  if is_semver_tag "$t"; then
    any_semver=true
    if [[ -z "$latest" ]]; then
      latest="$t"
    else
      latest="$(printf '%s\n%s\n' "$latest" "$t" | sort -V | tail -1)"
    fi
  fi
done < <(git tag -l 'v*' 2>/dev/null || true)

subject="$(git log -1 --pretty=%s)"
if [[ ! "$subject" =~ \(#([0-9]+)\)[[:space:]]*$ ]]; then
  echo "release: merge commit subject has no pull request number (#N)" >&2
  exit 1
fi
pr="${BASH_REMATCH[1]}"

label_lines=""
if [[ -n "${RELEASE_VERSION_TEST_LABELS+x}" ]]; then
  label_lines="$RELEASE_VERSION_TEST_LABELS"
elif [[ "${RELEASE_VERSION_TEST_LABEL_LOOKUP_FAIL:-}" == "1" ]]; then
  echo "release: label lookup failed for pull request #${pr}" >&2
  exit 1
else
  if ! label_lines="$(gh pr view "$pr" --json labels -q '.labels[].name' 2>/dev/null)"; then
    echo "release: label lookup failed for pull request #${pr}" >&2
    exit 1
  fi
fi

has_minor=false
has_major=false
while IFS= read -r label; do
  [[ -n "$label" ]] || continue
  case "$label" in
    release:minor) has_minor=true ;;
    release:major) has_major=true ;;
  esac
done <<<"$label_lines"

if $has_minor && $has_major; then
  echo "release: both release:minor and release:major are set" >&2
  exit 1
fi

if ! $any_semver; then
  echo "tag v0.1.0"
  exit 0
fi

ver="${latest#v}"
IFS='.' read -r major minor patch <<<"$ver"
major="${major:-0}"
minor="${minor:-0}"
patch="${patch:-0}"

if $has_major; then
  major=$((major + 1))
  minor=0
  patch=0
elif $has_minor; then
  minor=$((minor + 1))
  patch=0
else
  patch=$((patch + 1))
fi

echo "tag v${major}.${minor}.${patch}"
