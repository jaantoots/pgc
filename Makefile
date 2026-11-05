.PHONY: all web bindings release install test check dev screenshots clean

all: release

web/node_modules: web/package.json web/package-lock.json
	cd web && npm ci
	touch web/node_modules

# The UI is embedded into the binary from web/dist at compile time.
web: web/node_modules
	cd web && npm run build

# TypeScript types for the UI, generated from the Rust types by ts-rs into
# web/src/bindings (committed). `cargo test` writes them too.
bindings:
	rm -rf web/src/bindings
	cargo test --quiet export_bindings

release: web
	cargo build --release

install: web
	cargo install --path .

# Set PGC_TEST_CONNINFO (e.g. "dbname=postgres") to also run tests against a live server.
test: web/node_modules
	cargo test
	cd web && npm test

check: web/node_modules bindings
	cargo fmt --check
	cargo clippy --all-targets -- -D warnings
	@git diff --quiet -- web/src/bindings && test -z "$$(git ls-files --others --exclude-standard web/src/bindings)" \
		|| { echo "web/src/bindings changed: add the regenerated files"; exit 1; }
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
