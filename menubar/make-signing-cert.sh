#!/bin/bash
# Create a local code-signing certificate, "Clawdbox Local Signing", in your login keychain
# (once per Mac). menubar/build.sh signs Clawdbox.app with it when it exists.
#
# Why: macOS ties the Bluetooth permission to the app's code signature. An ad-hoc signature
# changes with every rebuild, so after each update macOS asked for Bluetooth again. A
# certificate that stays the same keeps the signature's identity the same across rebuilds.
# It is self-signed and never leaves this Mac; it is not a Developer ID and is not trusted
# for anything else.
set -euo pipefail
NAME="Clawdbox Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "\"$NAME\" already exists in your login keychain; nothing to do."
  exit 0
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$TMP/cert.cnf" \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null
# A throwaway passphrase: the .p12 only exists in $TMP for the import below.
PASS="clawdbox-$RANDOM$RANDOM"
/usr/bin/openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" \
  -out "$TMP/identity.p12" -passout "pass:$PASS"
# -T lets codesign use the key without a keychain prompt (updates rebuild the app unattended).
security import "$TMP/identity.p12" -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign >/dev/null
echo "created \"$NAME\" in your login keychain."
echo "Rebuild the app so it is signed with it:  menubar/install.sh"
echo "macOS asks for Bluetooth once more after that rebuild, and then no longer after updates."
