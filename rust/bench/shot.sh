#!/bin/sh
# bench/shot.sh <view> <game> <out.png> [w] [h]: controller on a virtual screen showing that view.
V=$1; G=$2; OUT=$3; W=${4:-1600}; H=${5:-1000}
U=/tmp/isu-shot-$V-$G; rm -rf $U; mkdir -p $U
node -e '
const {createInitialState}=require("../src/game-config.js");' 2>/dev/null
python3 - "$V" "$G" "$U" <<'P'
import json,sys,subprocess
v,g,u=sys.argv[1:4]
st=json.load(open("crates/isu-core/data/game-config.json"))["initialState"] if False else None
P
cat > $U/control-state.json <<J
{"version":4,"games":{},"selectedGame":"$G","activeView":"$V","setupSeen":true}
J
D=:97
Xvfb $D -screen 0 ${W}x${H}x24 -extension GLX >/dev/null 2>&1 & XP=$!
sleep 1.5
ISU_CONTROL_USER_DATA=$U DISPLAY=$D WAYLAND_DISPLAY= ./target/debug/isu-broadcast-control >$U/log 2>&1 & AP=$!
for i in $(seq 1 40); do curl -s localhost:3174/api/health >/dev/null && break; sleep 0.3; done
sleep 1.5
WID=$(DISPLAY=$D xdotool search --name "ISU Esports" | head -1)
[ -n "$WID" ] && DISPLAY=$D xdotool windowmove $WID 0 0 windowsize $WID $W $H
sleep 1.5
DISPLAY=$D import -window root "$OUT"
kill $AP 2>/dev/null; sleep 0.5; kill $XP 2>/dev/null
