#!/bin/bash
# Double-click this on macOS (or run it on Linux) to start openmw-web.
# It just runs server.py from this folder — nothing is installed.
cd "$(dirname "$0")" || exit 1
command -v python3 >/dev/null || {
  echo "Python 3 is required but was not found."
  echo "Install it from https://www.python.org/downloads/ and double-click this again."
  read -r -p "Press Return to close."
  exit 1
}
# Not `exec`: on failure we want the window to stay up long enough to read why.
python3 server.py || { echo; read -r -p "Press Return to close."; }
