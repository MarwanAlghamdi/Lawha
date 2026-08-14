#!/bin/sh
#
# Turns LAWHA_TLS=on into a `listen 8443 ssl` directive, or into a refusal.
#
# Mounted at /docker-entrypoint.d/40-lawha-tls.sh, which the nginx image runs
# before starting nginx. The number places it AFTER 20-envsubst-on-templates.sh
# — docker/nginx.conf is a template, and this writes a file that template
# `include`s, so it has to land while nginx is still not running.
#
# WHY A SCRIPT AND NOT A TEMPLATE. envsubst substitutes variables; it has no
# conditionals. A template cannot say "these three lines only when the flag is
# set", and every trick that fakes it — a variable expanding to a whole block, a
# second server block behind a mount that may not exist — fails in a way that
# takes the stack down rather than turning a feature off. Nine lines of shell
# with a real `if` is the honest version.
#
# WHAT IT REFUSES, and why refusing is the whole point. `LAWHA_TLS=on` with no
# certificate could start nginx perfectly happily on 8080 alone. The operator
# would then find https://host:9443 simply not answering, with a healthy stack,
# a green healthcheck and nothing in any log — the exact shape of failure this
# project calls "silence is the bug". So this exits non-zero and names the file
# it could not find, and the container does not start.
set -eu

CONF_DIR=/etc/nginx/lawha
CERT=/etc/nginx/certs/lawha-cert.pem
KEY=/etc/nginx/certs/lawha-key.pem

mkdir -p "$CONF_DIR"

# Start from empty every time. The directory lives in the image layer, so
# without this a container that once had TLS on would keep serving it after the
# flag was removed — a setting that cannot be turned off is worse than one that
# cannot be turned on, because nobody goes looking for it.
rm -f "$CONF_DIR"/tls.conf

case "${LAWHA_TLS:-}" in
  on | true | 1) ;;
  *)
    echo "lawha: TLS off (LAWHA_TLS is '${LAWHA_TLS:-unset}'); serving plain HTTP on 8080 only"
    exit 0
    ;;
esac

if [ ! -r "$CERT" ] || [ ! -r "$KEY" ]; then
  echo "lawha: REFUSING TO START. LAWHA_TLS is on, but the certificate is not readable at $CERT / $KEY." >&2
  echo "lawha:" >&2
  echo "lawha: Nothing here can mint one. Generate it on the HOST, in the repo root:" >&2
  echo "lawha:     ./run.sh tls" >&2
  echo "lawha:" >&2
  echo "lawha: Then bring the stack back up. Note that 'docker compose restart'" >&2
  echo "lawha: will NOT pick up a new mount — a container's mounts are fixed when" >&2
  echo "lawha: it is created, not when it starts. Use ./run.sh, or:" >&2
  echo "lawha:     docker compose up -d --force-recreate lawha-app" >&2
  exit 1
fi

cat >"$CONF_DIR/tls.conf" <<'EOF'
  # Written by docker/nginx-tls.sh. Do not edit in place — it is rewritten on
  # every container start, and an edit here disappears at the next one.
  #
  # This is included INSIDE the server block in docker/nginx.conf, so it adds a
  # listener to the block that already has every location. There is deliberately
  # no `server_name`, no `root`, no duplicated `location`, and no
  # Strict-Transport-Security: all of those belong to the block including it,
  # and HSTS on a locally-signed certificate locks the first visitor out for
  # good (ADR 0005 point 5).
  listen 8443 ssl;
  http2 on;

  ssl_certificate     /etc/nginx/certs/lawha-cert.pem;
  ssl_certificate_key /etc/nginx/certs/lawha-key.pem;

  # TLS 1.2 as the floor rather than 1.3 only: this is a LAN deployment and the
  # devices on a LAN include the one nobody has updated. 1.0 and 1.1 are not
  # offered at all.
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers off;
  ssl_session_cache shared:LAWHA:10m;
  ssl_session_timeout 1d;
  ssl_session_tickets off;
EOF

echo "lawha: TLS on — listening on 8443 with $CERT"
