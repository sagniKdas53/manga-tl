#!/bin/sh
set -eu

check() {
  actual=$(sha256sum "/usr/share/fonts/opentype/comic-neue/$2" | cut -d ' ' -f 1)
  [ "$actual" = "$1" ] || { echo "Comic Neue checksum mismatch: $2" >&2; exit 78; }
}
check 2728ee8f303e31934e62bf27b044fd7657b0613412d51f7444db1078cc3a7cb2 ComicNeue-Regular.otf
check 0637fea8f858cd1d9a6e0ff786bed3d8cc2dc59b871a28e268a5a0106f052a92 ComicNeue-Bold.otf
exec node src/server.mjs
