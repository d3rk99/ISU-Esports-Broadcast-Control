#!/bin/sh
# Peak memory of a command and all its child processes (tesseract.js runs Node worker threads;
# the Rust reader is one process): samples VmRSS of the process tree every 20 ms.
"$@" > /dev/null 2>&1 &
pid=$!
peak=0
while kill -0 $pid 2>/dev/null; do
  tot=0
  for p in $pid $(pgrep -P $pid); do
    r=$(awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null); tot=$((tot + ${r:-0}))
  done
  [ $tot -gt $peak ] && peak=$tot
  sleep 0.02
done
echo "peak RSS: $((peak / 1024)) MB"
