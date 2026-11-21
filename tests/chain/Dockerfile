# The chain's one empty Linux machine: git, bun and Claude Code, and nothing of tmb's. tmb comes
# in at step 0 through the real install script, from the build under test. The model login is
# passed in when the container starts, never kept in the image.
#   bun tests/chain/container.ts    builds this image and runs the chain in it
FROM oven/bun:1.4

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 sqlite3 nodejs npm \
 && rm -rf /var/lib/apt/lists/*

# Claude Code, the host the session steps drive.
RUN npm install --global @anthropic-ai/claude-code \
 && npm cache clean --force

WORKDIR /out
