#!/bin/sh
# Build the native gate driver against a libqsp 5.9.5 tree.
#
#   QSP_SRC=/path/to/qsp-5.9.5 ./build.sh            # QSP_BUILD defaults to $QSP_SRC/build
#
# libqsp itself is built first, the normal way, with a system oniguruma:
#   cmake -S "$QSP_SRC" -B "$QSP_BUILD" -DCMAKE_BUILD_TYPE=Release \
#         -DUSE_INSTALLED_ONIGURUMA=ON -Doniguruma_DIR=<dir with onigurumaConfig.cmake>
#   cmake --build "$QSP_BUILD"
# (Some package managers ship oniguruma with a .pc file and no CMake package
#  config; that directory can then be a three-line shim pointing at the prefix.)
#
# The binary lands in ./build/ and is never committed.
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
: "${QSP_SRC:?set QSP_SRC to a libqsp 5.9.5 source tree}"
: "${QSP_BUILD:=$QSP_SRC/build}"
: "${CC:=cc}"
OUT="${OUT:-$DIR/build}"
mkdir -p "$OUT"
"$CC" -O2 -D_UNICODE \
  -I"$QSP_SRC/qsp/bindings/default" -I"$QSP_SRC/qsp/bindings" -I"$QSP_BUILD" \
  "$DIR/driver.c" -o "$OUT/qsp595-check" \
  -L"$QSP_BUILD" -lqsp -Wl,-rpath,"$QSP_BUILD"
echo "built $OUT/qsp595-check"
