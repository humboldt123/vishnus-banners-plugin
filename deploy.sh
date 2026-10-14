#!/bin/sh
# Copy the plugin into the vault. Reload it in Obsidian afterwards (toggle it off/on).
set -e
DEST="$HOME/Obsidian/Personal/.obsidian/plugins/vishnus-banners"
mkdir -p "$DEST"
cp main.js manifest.json styles.css covers.json "$DEST/"
echo "Deployed to $DEST"
