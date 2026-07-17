.DEFAULT_GOAL := help

.PHONY: help init link force prune status test install

help:
	@printf '%s\n' \
	  'Developer commands:' \
	  '  make install              Install Node.js dependencies' \
	  '  make init                 Configure local target directories' \
	  '  make link                 Link skills to configured targets' \
	  '  make force                Replace conflicting skill paths' \
	  '  make prune                Remove stale links managed by this repo' \
	  '  make status               Inspect links without changing files' \
	  '  make test                 Run tests' \
	  '' \
	  'Optional: TARGET=~/.another-agent/skills'

install:
	npm install

init:
	npm run init

link:
	npm run link -- $(if $(TARGET),--target "$(TARGET)",)

force:
	npm run force -- $(if $(TARGET),--target "$(TARGET)",)

prune:
	npm run prune -- $(if $(TARGET),--target "$(TARGET)",)

status:
	npm run status -- $(if $(TARGET),--target "$(TARGET)",)

test:
	npm test
