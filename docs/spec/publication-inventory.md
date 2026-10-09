# Private build / public publication connection

CI aggregation supports an explicit `--link-files` mode for immutable files on the same staging filesystem, avoiding duplicated installer storage. The default local operation remains a copy. All original and merged checksums/inventory gates still apply; hard links are regular files, not symlinks. Never edit an installer through either linked path.

The private `flatt-app` workflow owns native builds and aggregation. This public repository owns published releases and verifies a prepared draft before optional publication. Only installers, update manifests, blockmaps, public notes and a hashed `release-inventory.json` are accepted; private source and credentials are never release assets.

An inventory release must include Windows x64, Linux x64/ARM64 and macOS x64/ARM64 at one version/source SHA. Verify every listed byte/hash, exact target filenames, all Linux formats and manifests. macOS has one merged manifest referencing both ZIPs. Linux AppImages contain their differential blockmap internally and do not require an external `.blockmap`. Legacy Windows-only draft validation remains supported. Unexpected assets fail verification.

Publication preserves immutable existing releases and beta/stable separation. Stable publication must be newer than the current stable release. Tests cover corrupted inventory, missing targets, extra/source files, Linux assets and dual-architecture macOS manifests. A live release additionally requires the private repository's restricted Contents-write credential and an explicit workflow dispatch.

Electron Builder 26.8.1 native macOS manifests reference ZIP and DMG entries. Accept the ZIP for each architecture plus its optional DMG entry, preserve original hashes and verify every referenced byte. ZIP-only metadata remains compatible; DMG-only, duplicate, foreign architecture and corrupted DMG entries must fail. The private aggregator uses this same coverage rule before producing the merged public manifest.

Native Linux filenames preserve format-specific architecture labels observed in successful run `37679956573`: x64 uses `x86_64.AppImage`, `amd64.deb`, `x86_64.rpm` and `x64.pkg.tar.zst`; ARM64 uses `arm64.AppImage`, `arm64.deb`, `aarch64.rpm` and `aarch64.pkg.tar.zst`. Inventory target identity remains linux-x64/linux-arm64. Require exactly these names and all formats, without renaming installer files. Updater manifests reference the native AppImage names.

Native Linux manifests also reference DEB/RPM/Arch packages. Preserve and verify these optional metadata references while requiring the AppImage. AppImage-only metadata remains supported; complete inventory still requires all formats. Original manifests from five native artifacts are regression fixtures for filename coverage, not evidence of binary installation or hash verification against downloaded historical installers.
