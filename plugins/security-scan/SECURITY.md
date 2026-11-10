# Security reports

For a suspected vulnerability in this plugin, use the repository host's **private vulnerability reporting / security advisory** channel if enabled. If unavailable, contact the maintainer through the repository's published contact channel to agree on a private report before sending sensitive details. No dedicated security inbox or response-time commitment is currently advertised. Do not open a public issue containing exploit details, secrets, private source or full user profiles.

Include plugin and exact DSH/scanner versions, operating system, the affected boundary, expected/actual behavior, and a minimal synthetic reproduction. State whether the problem concerns path containment, credential exposure, report rendering, command execution, authorization, installation or lifecycle cleanup. Share redacted logs; do not attach API keys, cookies, token stores or production reports. Public issues are suitable for ordinary feature requests and sanitized rule-quality examples.

The optional runtime baseline only contacts a URL you configure and authorize. It sends at most 12 same-origin GET requests, follows no cross-origin redirects, and stores no response bodies or cookie values. Report issues where it contacts another origin, sends a non-GET method, or persists response content.

The compatibility target is the exact runtime in `package.json`. Security fixes are delivered in new catalog packages; old installed versions are not silently modified. Before using a shared report, review its repository metadata and evidence excerpts. Deterministic candidates and AI conclusions are review aids; a completed scan is not a security certification or proof that a codebase is vulnerability-free.
