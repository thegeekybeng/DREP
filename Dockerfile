FROM node:20-alpine
WORKDIR /app

# SKIP_AUDIT=true (default) = fast build, no network audit
# Pass --build-arg SKIP_AUDIT=false to run: npm audit --audit-level=high
ARG SKIP_AUDIT=true

COPY package.json .
RUN if [ "$SKIP_AUDIT" = "false" ]; then \
      npm install --production && npm audit --audit-level=high; \
    else \
      npm install --production --no-audit; \
    fi

COPY . .

# su-exec: lightweight privilege-drop tool (standard Alpine pattern)
RUN apk add --no-cache su-exec

# Non-root user — the container STARTS as root so entrypoint.sh can fix
# volume ownership, then drops to appuser via su-exec before exec'ing node.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup && \
    chown -R appuser:appgroup /app

RUN chmod +x /app/entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/app/entrypoint.sh"]
