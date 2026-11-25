-include .env

ENVIRONMENT ?= staging
REGION ?= asia-southeast2
REGISTRY ?= $(REGION)-docker.pkg.dev/$(PROJECT_ID)/$(ENVIRONMENT)-deus
TAG ?= $(shell git rev-parse --short=8 HEAD)
SERVICES ?= $(notdir $(wildcard services/*))
APPS ?= $(SERVICES) web
PLATFORM ?= linux/amd64

.PHONY: install check lint typecheck test test-integration web e2e traffic chart auth build release

install:
	bun install --frozen-lockfile

lint:
	bunx biome check .

typecheck:
	bun run typecheck

test:
	bun test

web:
	cd web && bun run check && bun run test && bun run build

e2e:
	cd web && bun run e2e

traffic:
	docker run --rm -v "$(CURDIR)/charts/traffic/scripts:/scripts:ro" -e BASE_URL=http://host.docker.internal:8080 \
		-e AUTH_ORIGIN=http://localhost:8080 -e DURATION=$(or $(DURATION),1m) grafana/k6:2.3.0 \
		run --no-usage-report /scripts/traffic.js

test-integration:
	@docker rm -f deus-test-postgres deus-test-redis >/dev/null 2>&1 || true
	docker run -d --name deus-test-postgres -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:18.6-trixie >/dev/null
	docker run -d --name deus-test-redis -p 56379:6379 redis:8.2.3-alpine --requirepass redis >/dev/null
	@until docker exec deus-test-postgres pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
	@until docker exec deus-test-redis redis-cli -a redis --no-auth-warning ping >/dev/null 2>&1; do sleep 1; done
	DATABASE_TEST_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
		REDIS_TEST_URL=redis://default:redis@127.0.0.1:56379/0 bun test; status=$$?; \
		docker rm -f deus-test-postgres deus-test-redis >/dev/null; exit $$status

chart:
	@for s in $(APPS); do \
		dir=$$( [ "$$s" = web ] && echo web || echo services/$$s ); \
		helm template $$s charts/service -n $(ENVIRONMENT)-deus -f $$dir/deploy/values.yaml \
			-f $$dir/deploy/values-$(ENVIRONMENT).yaml \
			--set image.registry=registry.invalid,image.tag=check >/dev/null || exit 1; \
		echo "chart ok: $$s"; \
	done
	@helm template traffic charts/traffic -n $(ENVIRONMENT)-deus -f traffic/deploy/values.yaml >/dev/null && echo "chart ok: traffic"

check: lint typecheck test web chart

auth:
	@test -n "$(PROJECT_ID)" || { echo "PROJECT_ID is empty: cp .env.example .env"; exit 1; }
	gcloud auth configure-docker $(REGION)-docker.pkg.dev --quiet

build:
	@test -n "$(SERVICE)" || { echo "usage: make build SERVICE=<name>"; exit 1; }
	@test -n "$(PROJECT_ID)" || { echo "PROJECT_ID is empty: cp .env.example .env"; exit 1; }
	docker buildx build --platform $(PLATFORM) --build-arg SERVICE=$(SERVICE) \
		--build-arg APP_VERSION=$(TAG) --build-arg APP_ENVIRONMENT=$(ENVIRONMENT) \
		$(if $(filter web,$(SERVICE)),-f web/Dockerfile,) -t $(REGISTRY)/$(SERVICE):$(TAG) --push .

release:
	@test -z "$$(git status --porcelain)" || { echo "commit or stash your changes first: the image tag is the commit"; exit 1; }
	@for s in $(APPS); do $(MAKE) --no-print-directory build SERVICE=$$s TAG=$(TAG) || exit 1; done
	@for s in $(SERVICES); do bun scripts/set-image-tag.ts services/$$s/deploy/values-$(ENVIRONMENT).yaml $(TAG); done
	@bun scripts/set-image-tag.ts web/deploy/values-$(ENVIRONMENT).yaml $(TAG)
	@echo "images $(TAG) pushed; commit the values-$(ENVIRONMENT).yaml files and push to deploy"
