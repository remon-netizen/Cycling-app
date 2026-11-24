#!/bin/zsh
# Double-click to start Sommet. Web Bluetooth needs Chrome or Edge.
cd "$(dirname "$0")"
PORT=8765
python3 -m http.server $PORT >/dev/null 2>&1 &
SERVER=$!
trap "kill $SERVER" EXIT
sleep 1
open -a "Google Chrome" "http://localhost:$PORT/" 2>/dev/null || open -a "Microsoft Edge" "http://localhost:$PORT/"
echo "Sommet is running at http://localhost:$PORT/  (close this window to stop it)"
wait $SERVER
