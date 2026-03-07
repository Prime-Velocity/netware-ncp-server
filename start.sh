#!/bin/bash
# Source secrets if available
[ -f ~/.secrets ] && export $(grep -v '^#' ~/.secrets | xargs)

export GH_TOKEN="${GITHUB_TOKEN_PRIME_VELOCITY}"
export GH_OWNER="Prime-Velocity"
export NCP_PORT="${NCP_PORT:-5240}"

exec node /home/zorin/netware-ncp-server/index.js
