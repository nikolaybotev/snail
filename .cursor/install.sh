#!/usr/bin/env bash
set -euo pipefail

if [ ! -x "${HOME}/.local/bin/mise" ]; then
  curl -fsSL https://mise.run/bash | sh
fi

export PATH="${HOME}/.local/bin:${PATH}"
eval "$(mise activate bash)"

# Node LTS. No mise.toml in the repo; pin the toolchain here so install does not write one.
mise install node@lts
mise use -g node@lts
mise reshim

# Cloud Agent Skills menu and runtime read ~/.cursor/skills-cursor. Existing skill folders are left in place.
curl -fsSL https://raw.githubusercontent.com/nikolaybotev/local-skills/main/install.sh | sh -s -- ~/.cursor/skills-cursor
