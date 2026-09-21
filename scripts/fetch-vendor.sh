#!/usr/bin/env bash
# Downloads third-party reference material used only as test oracles and
# test fixtures. Nothing here is part of the library. See docs/PLAN.md.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p vendor/interp vendor/programs

# Reference interpreters (public domain / CC0).
curl -sL http://oerjan.nvg.org/esoteric/Unshackled.hs -o vendor/interp/Unshackled.hs
curl -sL https://malbolge.org/unshackled/Unshackled.c -o vendor/interp/Unshackled.c
curl -sL https://malbolge.org/unshackled/Unshackled-20.c -o vendor/interp/Unshackled-20.c
if command -v gcc >/dev/null; then
  gcc -O3 -o vendor/interp/unshackled vendor/interp/Unshackled.c
  gcc -O3 -o vendor/interp/unshackled20 vendor/interp/Unshackled-20.c
fi

# Example programs from malbolge.org, used as interpreter test fixtures.
for p in hello-world cat brainfuck quine; do
  curl -sL "https://malbolge.org/unshackled/$p.mu" -o "vendor/programs/$p.mu"
done
printf '%s\n' '(=BA#9"=<;:3y7x54-21q/p-,+*)"!h%B0/.' '~P<' '<:(8&' '66#"!~}|{zyxwvu' 'gJ%' > vendor/programs/cat-forever.mb
echo "vendor/ populated"
