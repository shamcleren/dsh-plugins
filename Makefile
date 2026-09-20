.PHONY: help init export-public

.DEFAULT_GOAL := help

# Export values as data, preserving paths with spaces without shell interpolation.
export DSH_INIT_DIR = $(DIR)
export DSH_INIT_WEB_ONLY = $(WEB_ONLY)
export DSH_INIT_MARKETPLACE = $(MARKETPLACE)
export DSH_INIT_RESUME = $(RESUME)
export DSH_INIT_REBUILD = $(REBUILD)

help:
	@printf '%s\n' \
		'make init [DIR=/new/path] [WEB_ONLY=1] [MARKETPLACE=1] [RESUME=1] [REBUILD=1]' \
		'First-time install only. After init, dhp is a user command:' \
		'  dhp help' \
		'  dhp plugin list' \
		'  dhp plugin install wechat' \
		'  dhp plugin update --all' \
		'  dhp restart' \
		'  dhp update' \
		'make export-public DEST=/path/to/dsh-plugins' \
		'Copy the working tree to a public GitHub checkout without AIDEV or the internal Git host.'

export-public:
	@test -n "$(DEST)" || { printf '%s\n' 'usage: make export-public DEST=/path/to/dsh-plugins'; exit 1; }
	@node scripts/export-public.mjs --dest "$(DEST)"

init:
	@/bin/sh scripts/init.sh
