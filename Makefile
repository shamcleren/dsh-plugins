.PHONY: help init

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
		'Initialize or repair an installation. Daily commands:' \
		'  dhp help' \
		'  dhp doctor' \
		'  dhp plugin list' \
		'  dhp plugin install wechat' \
		'  dhp plugin update --all' \
		'  dhp restart' \
		'  dhp update'

init:
	@/bin/sh scripts/init.sh
