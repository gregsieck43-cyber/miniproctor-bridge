# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc14

Download the four assets attached to the [v0.6.0-rc14 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc14). Verify the ZIP against its `.sha256` file, then follow `README-RELEASE.txt` in the archive. The ZIP is 370647 bytes and its SHA-256 is `d32808bfe2be1d6fe60bdef76f3c75affd940980c7b65691fce247f75f6c3116`. Node.js 22 or newer is required. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

This preview adds the fixed read-only CodeBuddy CLI 2.159.0 Windows profile, validated locally with real create/read/stop/usage and a denied write request. It updates Auggie and Kiro parsers and evidence for their current CLI formats; their account-gated normal runs remain unverified and disabled. Other locally verified profiles remain included. Third-party CLIs and account login are separate from this bridge ZIP. The V1.2 product release is still blocked by real device and 27 product Agent acceptance tests.

Source provenance: the archive manifest records the mini program workspace commit used to build this package. The release tag points to the matching distribution source in this repository.
