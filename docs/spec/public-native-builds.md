# Public native desktop builds

## Rules and ownership

The manually dispatched `Build desktop release` workflow in public `flatt-releases` owns native build admission and release preparation. Source remains in private `LuminaSoft-br/flatt-app`. Input is a complete, immutable 40-character source commit SHA, never a branch or arbitrary shell expression. The root source package owns the version. Public release scripts own aggregation, checksums and publication; private source scripts only prepare, compile and package the application.

Use standard runners for Windows x64, Linux x64/ARM64 and macOS Intel/ARM64. All five targets must use the exact admitted source SHA and version. No old binaries are renamed or combined with a new revision. Preparation defaults to a verified draft; publishing is a separate explicit input. Existing immutable-tag, monotonic-version and checksum rules remain mandatory. macOS remains unsigned and unnotarized; notes must explain manual installation and the automatic-update limitation.

## Credential and disclosure boundary

`FLATT_SOURCE_READ_TOKEN` is a fine-grained, expiring Contents read-only credential restricted to `flatt-app`. It is used only for source checkout and the pinned Windows runtime download. Checkout does not persist credentials. Build subprocesses receive neither source/public tokens nor Actions control-file or runtime credentials. The temporary public `GITHUB_TOKEN` grants Contents write only in the draft/publication job. No source-write credential is required and this pipeline does not create source tags.

Public workflow logs contain only fixed build-stage status and public release metadata. Private command stdout/stderr are never printed, including on failure. CI retains at most the last 2 MiB in a bounded diagnostic buffer; failed commands emit only an AES-256-GCM encrypted envelope, with its random key wrapped using RSA-OAEP/SHA-256 to the maintainer's checked-in public key. The private key stays on the maintainer machine outside both repositories. Successful commands produce no diagnostic artifact. Failure artifacts contain only encrypted envelopes, use a distinct artifact prefix, expire after seven days and are excluded from release aggregation/publication. No plaintext log is written to disk or uploaded. The synthetic graphical fixture forwards renderer console/load/termination diagnostics into this encrypted stream without changing assertions or deadlines.

There is no source/dependency cache, raw build-log artifact, source archive or source map upload. The artifact admission owner copies only files validated by the existing per-target manifest/provenance allowlist into a fresh staging directory. Installer upload targets only that directory, never the source checkout or raw dist folder. Symlinks and unexpected filenames fail before upload. GitHub's automatic source archives refer to this public distribution repository, not `flatt-app`.

## Event order and recovery

```mermaid
sequenceDiagram
    participant O as Operator
    participant W as Public workflow
    participant S as Private source
    participant B as Five native jobs
    participant R as Public Releases
    O->>W: Approved source SHA, publish=false
    W->>S: Read pinned checkout with read-only secret
    W->>W: Validate version, public notes and existing releases
    W->>B: Admit the same SHA/version
    B->>B: Build privately; validate and stage installer allowlist
    opt Command failure
        B->>B: Encrypt bounded diagnostic tail to maintainer public key
        B-->>W: Ciphertext-only failure artifact
        Note over O: Private decryption key stays off runners
    end
    B-->>W: Five hashed target artifacts
    W->>W: Verify complete inventory and merge manifests
    W->>R: Upload draft, redownload and verify every asset
    opt Explicit publish input
        W->>R: Publish verified draft
    end
```

The workflow uses the same publication concurrency group as the existing public verifier. A partial or failed build cannot publish. A publication retry uses the successful artifacts from the same run; the publisher resumes only a matching draft inventory. Re-running a native build requires fresh staging on its runner. Published versions are immutable.

## Acceptance

- Parsed workflow tests enforce manual-only admission, five standard native targets, pinned source checkout, read-only default permissions, no persisted credentials or broad caches, isolated tokens, exact staged uploads and complete publication dependencies.
- Subprocess tests inject secrets, source text and workflow commands into both streams and exceptions; none reaches the public log on success or failure. High-volume output is drained without accumulating it.
- Encrypted diagnostics tests cover authenticated roundtrip, tamper/wrong-recipient rejection, bounded tail capture and absence of plaintext in the uploaded envelope. The private key must never be committed, uploaded or printed.
- Linux graphical validation resolves the Electron executable through its public npm entrypoint from the desktop package. The source workspace uses `node-linker=hoisted`; a hardcoded `packages/desktop/node_modules/electron` path is invalid. A resolver test must cover the hoisted layout without relaxing graphical assertions.
- Admission tests reject mutable refs, mismatched versions, unsafe notes, unsupported targets and symlink/extra-file artifacts. Existing inventory/publisher tests continue to verify hashes, all five targets, native filenames and draft recovery.
- Live preparation records the source SHA, run URL and draft URL. Build/package success does not claim native installation, a Gentoo incident reproduction, or a signed macOS upgrade.
