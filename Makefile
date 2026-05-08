# ── Family Dietary Registry — Project Makefile ────────────────────────────────
# All commands run from this directory. Requires Docker + Compose v2.
#
#   make          → same as make up
#   make build    → rebuild image (Dockerfile or package.json changed)
#   make up       → start / restart container (bind mounts apply instantly)
#   make down     → stop and remove container
#   make restart  → graceful container restart (no rebuild)
#   make deploy   → build + up in one shot (most common after pkg changes)
#   make audit    → rebuild with npm audit gate (fails on high/critical vulns)
#   make logs     → tail live container logs
#   make health   → check /health endpoint
#   make shell    → exec into running container (debug)
#   make status   → show container state + resource usage
# ─────────────────────────────────────────────────────────────────────────────

COMPOSE  := docker compose
SERVICE  := family-registry
PORT     := 3100
HEALTH   := http://localhost:$(PORT)/health

.DEFAULT_GOAL := up

# ── Lifecycle ─────────────────────────────────────────────────────────────────

.PHONY: up
up:
	$(COMPOSE) up -d
	@echo "✓ $(SERVICE) running — http://localhost:$(PORT)"

.PHONY: build
build:
	$(COMPOSE) build
	@echo "✓ Image rebuilt"

.PHONY: deploy
deploy:
	$(COMPOSE) up -d --build
	@echo "✓ Built and deployed — http://localhost:$(PORT)"

.PHONY: audit
audit:
	$(COMPOSE) build --build-arg SKIP_AUDIT=false
	$(COMPOSE) up -d
	@echo "✓ Audit passed — deployed"

.PHONY: restart
restart:
	$(COMPOSE) restart $(SERVICE)
	@echo "✓ Restarted"

.PHONY: down
down:
	$(COMPOSE) down
	@echo "✓ Stopped"

# ── Observability ─────────────────────────────────────────────────────────────

.PHONY: logs
logs:
	$(COMPOSE) logs -f $(SERVICE)

.PHONY: health
health:
	@curl -sf $(HEALTH) && echo " — healthy" || echo "UNHEALTHY"

.PHONY: status
status:
	@$(COMPOSE) ps
	@echo ""
	@docker stats --no-stream $(SERVICE) 2>/dev/null || true

.PHONY: shell
shell:
	$(COMPOSE) exec $(SERVICE) sh
