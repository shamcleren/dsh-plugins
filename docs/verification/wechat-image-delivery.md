# WeChat image delivery correction

## Changes

- Route presented JPEG/PNG/GIF/WebP bytes to native image delivery, retaining video/file routes.
- Encode outbound media AES keys as base64 of the 32-character hexadecimal text, matching Tencent `openclaw-weixin` commit `874637a0dbc24050f72d1385add4fc6170a2d726` (`src/cdn/upload.ts`, `src/messaging/send.ts`). The earlier raw-byte base64 assumption was incorrect for the outbound client contract.
- Keep image/video sizes as ciphertext lengths and file length as plaintext length.
- Recognize valid message-ID-only acknowledgments while rejecting explicit errors and empty/invalid receipts. Real iLink sends exercised this acknowledgment form.
- Report media failures with sanitized stage/category diagnostics, without paths, credentials, signed URLs or raw server errors.

## Verification · 2026-11-14

Corrected protocol assertions first: the original implementation failed two regression tests. After correction, image/video/file fixed-input tests verify encoding, ciphertext decryption, size fields and request counts. Presented-image routing and failure sanitization have independent regression coverage.

The complete local development tree passed 310 tests and typecheck. A separate checkout based only on the committed baseline plus this scoped correction passed 249 tests across 43 files and typecheck; its private validation tarball built successfully. These counts differ because unrelated preexisting local features were deliberately excluded from the commit.

A locally installed 0.1.15 package was tested with the owner's authorized image. Upload and send were accepted, and the owner subsequently confirmed the new image displayed correctly. API acceptance alone was not treated as display verification. A separate pre-send CDN-readback experiment returned HTTP 400 and stopped before dispatch; no uncertain send was retried.

## Release boundary

This commit contains source, tests and documentation only. The user's existing local 0.1.15 deployment also contains earlier uncommitted IM functionality. Publishing the isolated correction as a newer catalog package would silently drop those features, so no catalog/version/artifact update is included here. A private validation package was not published or installed over the user's working version. Existing unrelated working-tree and lockfile changes remain local for separate review.
