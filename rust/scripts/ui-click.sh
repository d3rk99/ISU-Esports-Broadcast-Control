#!/bin/sh
# Dev helper: click the first on-screen word matching $1 (grep -E on "word x y"), optional nth match $2.
import -window root /tmp/ui-click.png
P=$(python3 "$(dirname "$0")/ui-find.py" /tmp/ui-click.png | grep -E "$1" | sed -n "${2:-1}p" | awk '{print $2" "$3}')
[ -z "$P" ] && { echo "not found: $1"; exit 1; }
xdotool mousemove $P click 1 2>/dev/null; echo "clicked $1 at $P"
