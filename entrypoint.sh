#!/bin/sh
set -e

# Running as root here — ensure data dirs exist with correct ownership
# before dropping privileges. This is the standard Docker pattern for
# containers that need to write to bind-mounted or named volumes.
mkdir -p /app/data/logs
chown -R appuser:appgroup /app/data

# Drop to non-root user and exec the app
exec su-exec appuser node server.js
