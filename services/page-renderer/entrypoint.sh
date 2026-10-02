#!/bin/sh
set -eu

expected=2728ee8f303e31934e62bf27b044fd7657b0613412d51f7444db1078cc3a7cb2
actual=$(sha256sum /usr/share/fonts/opentype/comic-neue/ComicNeue-Regular.otf | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] || { echo "Comic Neue checksum mismatch" >&2; exit 78; }
exec node src/server.mjs
