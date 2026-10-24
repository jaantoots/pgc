.PHONY: all web release install test check dev screenshots clean

all: release

web/node_modules: web/package.json web/package-lock.json
	cd web && npm ci
	touch web/node_modules

# The UI is embedded into the binary from web/dist at compile time.
web: web/node_modules
	cd web && npm run build

release: web
	cargo build --release

install: web
	cargo install --path .

# Set PGC_TEST_CONNINFO (e.g. "dbname=postgres") to also run tests against a live server.
test: web/node_modules
	cargo test
	cd web && npm test

check: web/node_modules
	cargo fmt --check
	cargo clippy --all-targets -- -D warnings
	cd web && npm run typecheck

# Backend on :8765, Vite dev server with hot reload on :5173 (proxies /api and /ws).
dev: web/node_modules
	cargo run -- --no-browser & cd web && npm run dev

# Regenerate docs/screenshots (needs a local PostgreSQL; see tools/screenshots/run.sh).
screenshots:
	tools/screenshots/run.sh

clean:
	cargo clean
	rm -rf web/dist web/node_modules
