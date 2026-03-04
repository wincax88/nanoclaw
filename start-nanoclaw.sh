#!/usr/bin/env bash
# Start NanoClaw in the background (Windows/Git Bash)
cd "$(dirname "$0")"
nohup node dist/index.js >> logs/nanoclaw.log 2>> logs/nanoclaw.error.log &
echo "NanoClaw started (PID: $!)"
echo "$!" > .nanoclaw.pid
