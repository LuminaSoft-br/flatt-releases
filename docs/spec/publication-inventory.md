# Private build / public publication connection

The private `flatt-app` workflow owns native builds and aggregation. This public repository owns published releases and verifies a prepared draft before optional publication. Only installers, update manifests, blockmaps, public notes and a hashed `release-inventory.json` are accepted; private source and credentials are never release assets.

An inventory release must include Windows x64, Linux x64/ARM64 and macOS x64/ARM64 at one version/source SHA. Verify every listed byte/hash, exact target filenames, all Linux formats and manifests. macOS has one merged manifest referencing both ZIPs. Linux AppImages contain their differential blockmap internally and do not require an external `.blockmap`. Legacy Windows-only draft validation remains supported. Unexpected assets fail verification.

Publication preserves immutable existing releases and beta/stable separation. Stable publication must be newer than the current stable release. Tests cover corrupted inventory, missing targets, extra/source files, Linux assets and dual-architecture macOS manifests. A live release additionally requires the private repository's restricted Contents-write credential and an explicit workflow dispatch.

Electron Builder 26.8.1 native macOS manifests reference ZIP and DMG entries. Accept the ZIP for each architecture plus its optional DMG entry, preserve original hashes and verify every referenced byte. ZIP-only metadata remains compatible; DMG-only, duplicate, foreign architecture and corrupted DMG entries must fail. The private aggregator uses this same coverage rule before producing the merged public manifest.
