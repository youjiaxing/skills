.DEFAULT_GOAL := help

.PHONY: help init link force prune status test install

help:
	@printf '%s\n' \
	  'Developer commands:' \
	  '  make install              Install Node.js dependencies' \
	  '  make init                 Configure local skill and prompt targets' \
	  '  make link                 Link skills and global prompts to configured targets' \
	  '  make force                Replace conflicting skill and prompt paths' \
	  '  make prune                Remove stale skill links managed by this repo' \
	  '  make status               Inspect links without changing files' \
	  '  make test                 Run tests' \
	  '' \
	  'Optional: TARGET=~/.another-agent/skills PROMPT_TARGET=~/.another-agent/AGENTS.md'

install:
	npm install

init:
	npm run init

link:
	npm run link -- $(if $(TARGET),--target "$(TARGET)",) $(if $(PROMPT_TARGET),--prompt-target "$(PROMPT_TARGET)",)

force:
	npm run force -- $(if $(TARGET),--target "$(TARGET)",) $(if $(PROMPT_TARGET),--prompt-target "$(PROMPT_TARGET)",)

prune:
	npm run prune -- $(if $(TARGET),--target "$(TARGET)",) $(if $(PROMPT_TARGET),--prompt-target "$(PROMPT_TARGET)",)

status:
	npm run status -- $(if $(TARGET),--target "$(TARGET)",) $(if $(PROMPT_TARGET),--prompt-target "$(PROMPT_TARGET)",)

test:
	npm test
