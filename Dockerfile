FROM --platform=${BUILDPLATFORM} node:24@sha256:8530f76a96d88820d288761f022e318970dda93d01536919fbc16076b7983e63 AS build

WORKDIR /opt/node_app

COPY . .

# The build context now carries lawha-server/ so that lawha-server/Dockerfile
# can see it — BuildKit reads only the root .dockerignore. The frontend build
# has no use for the server workspace, and leaving it in would make this image
# compile better-sqlite3's native binding for a Node major it never runs on.
RUN rm -rf lawha-server

# do not ignore optional dependencies:
# Error: Cannot find module @rollup/rollup-linux-x64-gnu
RUN --mount=type=cache,target=/root/.cache/yarn \
    npm_config_target_arch=${TARGETARCH} yarn --frozen-lockfile --network-timeout 600000

ARG NODE_ENV=production

RUN npm_config_target_arch=${TARGETARCH} yarn build:app:docker

FROM nginx:stable-alpine-slim@sha256:2c605dbeab79a6b2a63340474fe58119d0ef95bdc4b1f41df0aa689659b3d13b

COPY --from=build /opt/node_app/excalidraw-app/build /usr/share/nginx/html

# 8080, matching the single plain-HTTP listener in docker/nginx.conf. Nothing
# in this project listens on 80 any more — that port belongs to the gateway
# that maps names like http://lawha.local onto this machine's published port.
#
# /healthz rather than `/`, because it answers directly with no redirect in the
# path. busybox wget follows redirects, and a health probe that follows one is
# testing whatever it landed on rather than this server.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
