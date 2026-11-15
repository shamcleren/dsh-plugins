# WeChat presented-file scope · 0.1.16

## Evidence

The direct image-transport test succeeded, but real conversation turns 23 and 24 still failed to deliver a presented JPEG. Offline replay using the installed projection produced one presented file for each turn; neither the model nor event projection omitted the attachment. The running Host and installed plugin were confirmed to be 0.1.15.

An isolated official Host reproduced `cannot get property "workspaceFiles" without inject` when the file reader used its parent plugin context. The adapter declared other dependencies but accessed the optional file service through that uninjected context. Ordinary object mocks did not enforce Cordis dependency scoping, which explains the previous coverage gap. Direct `sendImage` bypassed this entire file-reading layer.

## Correction

`createPresentedFileReader` captures a scope explicitly injected with `workspaceFiles` and `sessionController`, exposes a bounded reader through that scope, and clears the reader when the optional service unloads. The adapter no longer accesses `workspaceFiles` on its parent context. Missing services still produce a controlled unavailable-reader failure instead of disabling text messaging.

## Verification · 2026-11-15

- Complete local tree: 49 test files, 311 tests and TypeScript check passed.
- Isolated committed baseline plus only this follow-up: 43 test files, 250 tests, TypeScript check and build passed. The lower count excludes unrelated uncommitted features.
- New regression verifies injected-scope access, missing-service handling and disposal.
- Extended packaged Host probe emits a durable presented-file event and verifies actual workspace service reading, JPEG routing and exact image bytes rather than mocking away the file services.
- Full isolated official Host smoke passed.
- One authorized live transport check used the same itinerary image and original bound peer: a synthetic isolated official Session produced the presented event, the real workspace service read 582687 bytes, the router dispatched the native image, and iLink accepted it. No duplicate send was attempted. This was not a new model turn in the user's production conversation.
- Built and installed the local 0.1.16 catalog package, preserving existing local features. Restarted through the native controller after the production turn had ended; new Host became ready.
- Tarball SHA-256: `2fbe2aec8456ce1c18ad41cde47feaf8e381bd28b269ab91619ad711267ea3be`.

The owner subsequently confirmed that a fresh ordinary DSH conversation delivered the image successfully. This completes the production-conversation acceptance check; it is distinct from platform acceptance in the isolated test.

The follow-up commit contains only the optional-service injection fix, its regression test and this verification note. The existing local catalog/deployment contains other uncommitted features and is intentionally not published as part of this scoped source commit. Other local work remains untouched.
