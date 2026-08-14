#!/usr/bin/env bash
#
# Mints the TLS material Lawha needs: a small private CA, and a leaf for
# https://lawha.local signed by it.
#
# WHY A CA AND NOT JUST A SELF-SIGNED LEAF. The old procedure — a heredoc in
# README.md, duplicated in lawha-server/README.md — produced one `CA:FALSE`
# self-signed certificate. That works, but it has to be imported into the trust
# store of every phone and laptop that will use Lawha, and it has to be
# imported AGAIN every time it is re-issued: when it expires, when the machine
# changes address, when a name is added. Each re-issue is a round of "why is
# this warning back" across every device in the building.
#
# A CA moves that cost to once. Devices trust the CA; the leaf can be reissued
# as often as it likes.
#
# WHAT THIS BUYS AND WHAT IT COSTS, plainly. Anyone holding lawha-ca-key.pem
# can mint a certificate for ANY name that the devices trusting this CA will
# accept without complaint. That is a real key and it lives on this machine. It
# is 0600 and it never enters a docker image (.dockerignore excludes ./certs);
# a LAN deployment where the CA key and the database sit on the same box is a
# reasonable trade, and it is a trade rather than a free win.
#
# Idempotent. Re-running reissues the leaf and leaves the CA alone, so devices
# keep trusting the deployment across a re-issue. Delete certs/lawha-ca*.pem by
# hand if you genuinely want a new CA — and know that every device has to
# install the new one.

set -euo pipefail

cd "$(dirname "$0")/.."

CERT_DIR="certs"
CA_CERT="$CERT_DIR/lawha-ca.pem"
CA_KEY="$CERT_DIR/lawha-ca-key.pem"
LEAF_CERT="$CERT_DIR/lawha-cert.pem"
LEAF_KEY="$CERT_DIR/lawha-key.pem"

# 825 days is not arbitrary: Apple platforms reject server certificates with a
# validity longer than that outright, and "it works everywhere except on the
# iPhones" is a bad afternoon.
LEAF_DAYS=825
CA_DAYS=3650

PRIMARY_NAME="${LAWHA_CERT_NAME:-lawha.local}"

mkdir -p "$CERT_DIR"

# --- the addresses the certificate has to cover ------------------------------
#
# The SAN list is the part that matters and the CN is not. Browsers ignore CN
# entirely and match SAN, so a certificate whose SAN omits the address someone
# actually types is not a warning they can click past — Chrome refuses it with
# ERR_CERT_COMMON_NAME_INVALID and the page never loads at all.
#
# Every IPv4 address this machine answers on is included automatically, because
# the failure mode of forgetting one is indistinguishable from the server being
# down. Docker's own bridge addresses are filtered out: they are not reachable
# from anywhere a browser runs, and putting them in only makes the list longer.
mapfile -t HOST_IPS < <(
  hostname -I 2>/dev/null | tr ' ' '\n' |
    grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' |
    grep -Ev '^(172\.1[6-9]\.|172\.2[0-9]\.|172\.3[01]\.|10\.253\.)' || true
)

{
  printf '[req]\ndistinguished_name = dn\nprompt = no\n\n[dn]\nCN = %s\n\n' "$PRIMARY_NAME"
  printf '[ext]\nsubjectAltName = @alt\nbasicConstraints = CA:FALSE\n'
  printf 'keyUsage = digitalSignature, keyEncipherment\nextendedKeyUsage = serverAuth\n\n'
  printf '[alt]\nDNS.1 = %s\nDNS.2 = localhost\n' "$PRIMARY_NAME"
  printf 'IP.1 = 127.0.0.1\n'
  index=2
  for ip in "${HOST_IPS[@]}"; do
    [ "$ip" = "127.0.0.1" ] && continue
    printf 'IP.%d = %s\n' "$index" "$ip"
    index=$((index + 1))
  done
} >"$CERT_DIR/openssl.cnf"

# --- the CA, once ------------------------------------------------------------
if [ -f "$CA_CERT" ] && [ -f "$CA_KEY" ]; then
  echo "CA: reusing $CA_CERT (delete it by hand to mint a new one)"
else
  echo "CA: minting $CA_CERT"
  openssl req -x509 -newkey rsa:4096 -nodes -days "$CA_DAYS" \
    -keyout "$CA_KEY" -out "$CA_CERT" \
    -subj "/CN=Lawha Local CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  chmod 600 "$CA_KEY"
fi

# --- the leaf, every run -----------------------------------------------------
echo "leaf: issuing $LEAF_CERT for $PRIMARY_NAME"
openssl req -new -newkey rsa:2048 -nodes \
  -keyout "$LEAF_KEY" -out "$CERT_DIR/lawha.csr" \
  -config "$CERT_DIR/openssl.cnf" 2>/dev/null

openssl x509 -req -in "$CERT_DIR/lawha.csr" \
  -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
  -out "$LEAF_CERT" -days "$LEAF_DAYS" \
  -extfile "$CERT_DIR/openssl.cnf" -extensions ext 2>/dev/null

rm -f "$CERT_DIR/lawha.csr"
chmod 600 "$LEAF_KEY"
chmod 644 "$CA_CERT" "$LEAF_CERT"

echo
echo "Subject Alternative Names — every address anyone can type must be here:"
openssl x509 -in "$LEAF_CERT" -noout -text |
  grep -A1 "Subject Alternative Name" | tail -n1 | sed 's/^ */  /'
echo
echo "Install the CA on each device, once:  http://$PRIMARY_NAME/lawha-ca.pem"
echo "Then restart the stack so nginx picks the new leaf up:"
echo "  docker compose up -d --force-recreate lawha-app"
echo
echo "NOTE: 'docker compose restart' will NOT do it. A container's environment"
echo "and its mounts are fixed when the container is created, not when it starts."
