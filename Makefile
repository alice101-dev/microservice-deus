-include .env

ENVIRONMENT ?= staging
REGION ?= asia-southeast2
REGISTRY ?= $(REGION)-docker.pkg.dev/$(PROJECT_ID)/$(ENVIRONMENT)-deus
TAG ?= $(shell git rev-parse --short=8 HEAD)
SERVICES ?= $(notdir $(wildcard services/*))
PLATFORM ?= linux/amd64

.PHONY: install check lint typecheck test test-integration chart auth build release

install:
	bun install --frozen-lockfile

lint:
	bunx biome check .

typecheck:
	bun run typecheck

test:
	bun test

test-integration:
	@docker rm -f deus-test-postgres >/dev/null 2>&1 || true
	docker run -d --name deus-test-postgres -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:18.6-trixie >/dev/null
	@until docker exec deus-test-postgres pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
	DATABASE_TEST_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres bun test; status=$$?; \
		docker rm -f deus-test-postgres >/dev/null; exit $$status

chart:
	@for s in $(SERVICES); do \
		helm template $$s charts/service -n $(ENVIRONMENT)-deus -f services/$$s/deploy/values.yaml \
			-f services/$$s/deploy/values-$(ENVIRONMENT).yaml \
			--set image.registry=registry.invalid,image.tag=check >/dev/null || exit 1; \
		echo "chart ok: $$s"; \
	done

check: lint typecheck test chart

auth:
	@test -n "$(PROJECT_ID)" || { echo "PROJECT_ID is empty: cp .env.example .env"; exit 1; }
	gcloud auth configure-docker $(REGION)-docker.pkg.dev --quiet

build:
	@test -n "$(SERVICE)" || { echo "usage: make build SERVICE=<name>"; exit 1; }
	@test -n "$(PROJECT_ID)" || { echo "PROJECT_ID is empty: cp .env.example .env"; exit 1; }
	docker buildx build --platform $(PLATFORM) --build-arg SERVICE=$(SERVICE) \
		-t $(REGISTRY)/$(SERVICE):$(TAG) --push .

release:
	@test -z "$$(git status --porcelain)" || { echo "commit or stash your changes first: the image tag is the commit"; exit 1; }
	@for s in $(SERVICES); do $(MAKE) --no-print-directory build SERVICE=$$s TAG=$(TAG) || exit 1; done
	@for s in $(SERVICES); do bun scripts/set-image-tag.ts services/$$s/deploy/values-$(ENVIRONMENT).yaml $(TAG); done
	@echo "images $(TAG) pushed; commit services/*/deploy/values-$(ENVIRONMENT).yaml and push to deploy"
