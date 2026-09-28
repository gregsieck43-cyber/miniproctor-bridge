# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc13

Download the four assets attached to the [v0.6.0-rc13 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc13). Verify the ZIP against its `.sha256` file, then follow `README-RELEASE.txt` in the archive. The ZIP is 368714 bytes and its SHA-256 is `1cb5ebb7924bc271069d80f43927f90e23a3cb5776152bfba6f23a509018fe76`. Node.js 22 or newer is required. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

This preview records Factory Droid CLI 0.174.0 failure-frame usage and updates its product-bound parser, plus the fixed Amp CLI package prerequisite findings. Factory Droid and Amp still lack authenticated, safe create/read/stop validation; their capabilities remain disabled. The archive retains Cursor CLI 2026.09.26-dd393fe, GitHub Copilot CLI 1.0.88, OpenClaw 2026.9.6, Kimi Code 2.1.1, Cline 3.0.65, Continue 1.5.47, and Goose 1.52.0 local profiles. Third-party CLIs and account login are separate from this bridge ZIP. The V1.2 product release is still blocked by real device and 27 product Agent acceptance tests.

Source provenance: the archive manifest records the mini program workspace commit used to build this package. The release tag points to the matching distribution source in this repository.
