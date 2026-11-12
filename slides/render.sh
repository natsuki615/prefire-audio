#!/bin/sh
# Render slide charts to 2x PNGs (3840x2160) with headless Chrome.
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for page in channel_chart; do
  "$CHROME" --headless --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --force-device-scale-factor=2 --window-size=1920,1080 \
    --screenshot="$PWD/$page.png" "file://$PWD/$page.html"
done
