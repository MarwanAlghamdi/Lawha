# lawha-server: socket.io relay + REST + SQLite, in three stages.
#
# Build context is the REPO ROOT (see docker-compose.yml), because the root
# .dockerignore is the only one BuildKit reads.
#
# Reproducible since roadmap known issue 21 was closed: lawha-server/yarn.lock
# is committed and `--frozen-lockfile` below makes the install FAIL rather than
# silently re-resolve if it ever drifts from package.json.
#
# The lockfile is generated STANDALONE, not from the workspace root. This
# directory is a yarn workspace member, so `yarn install` run inside it
# resolves against the root lockfile and writes nothing here — while this image
# copies package.json alone and installs in isolation. Regenerate it the same
# way it was made: copy lawha-server/package.json to an empty directory, run
# `yarn install --ignore-scripts` there, and bring back the yarn.lock.
#
# Why it matters more than tidiness: `lawha-backup` runs this same image, so a
# drifting transitive means the better-sqlite3 that WRITES your backups can
# differ from the one that READS them on the day you need it to.

# --- deps: runtime dependencies only, nothing else ------------------------
FROM node:22-slim AS deps

WORKDIR /opt/lawha

# better-sqlite3 ships prebuilds, but keep a toolchain available so an
# unsupported platform falls back to building rather than failing the image.
# It lives in this stage only and never reaches the runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY lawha-server/package.json ./package.json
COPY lawha-server/yarn.lock ./yarn.lock
RUN yarn install --production --frozen-lockfile --non-interactive --network-timeout 600000

# --- build: add the devDependencies and compile ---------------------------
FROM deps AS build

# Layers on top of the production tree, so `deps` stays exactly what the
# runtime image needs and the compiler never ships.
RUN yarn install --frozen-lockfile --non-interactive --network-timeout 600000

COPY lawha-server/ ./
RUN yarn build

# --- runtime --------------------------------------------------------------
FROM node:22-slim AS runtime

WORKDIR /opt/lawha
ENV NODE_ENV=production

# `age` encrypts backups to LAWHA_BACKUP_RECIPIENT (a public key) so this
# image can never decrypt what it writes — see lib/ageEncrypt.ts. Debian
# packages it (1.1.1-1+b3 on this base, verified), so it is installed rather
# than vendored: a fetched binary would mean this image tracking upstream
# age releases itself, with no way to verify one against the other at build
# time. Runtime-only: `lawha-backup` runs this same image (see the comment
# at the top of this file), so both need it, and it never needs to reach the
# `deps`/`build` stages above, which never shell out to it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends age \
  && rm -rf /var/lib/apt/lists/*

# node_modules comes from `deps` (production only) rather than from `build`,
# so tsx, vitest, typescript and the socket.io client stay out of the image.
COPY --from=deps --chown=node:node /opt/lawha/node_modules ./node_modules
COPY --from=build --chown=node:node /opt/lawha/dist ./dist
COPY --from=build --chown=node:node /opt/lawha/package.json ./package.json

# The database and uploaded files live here; mount a volume over it.
# Chowning it in the image is what lets a fresh named volume come up owned by
# `node` — Docker seeds a new volume from the image directory, permissions and
# all. A BIND mount does not work that way: the host directory's ownership
# wins, so a bind mount must already be writable by uid 1000.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

ENV LAWHA_DB_PATH=/data/lawha.db \
    LAWHA_FILES_DIR=/data/files \
    LAWHA_PORT=3002 \
    LAWHA_HOST=0.0.0.0

# Nothing here needs root. Dropping it means an RCE in a dependency lands as
# an unprivileged user with write access to /data and nothing else.
USER node

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3002/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
