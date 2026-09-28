# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc12

Download the four assets attached to the [v0.6.0-rc12 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc12). Verify the ZIP against its `.sha256` file, then follow `README-RELEASE.txt` in the archive. The ZIP is 367669 bytes and its SHA-256 is `0468d27480ecf560b41a3f12a5a847168f1a0e4606a54d727a888a2592b84eab`. Node.js 22 or newer is required. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

This preview adds Cursor CLI 2026.09.26-dd393fe local create/read/stop/usage on Windows through a read-only Ask profile. Cursor CLI and its account login are installed separately. It retains GitHub Copilot CLI 1.0.88, OpenClaw 2026.9.6, Kimi Code 2.1.1, Cline 3.0.65, Continue 1.5.47, and Goose 1.52.0 local profiles. The V1.2 product release is still blocked by real device and 27 product Agent acceptance tests. A product appearing in the Agent catalog does not mean it can start or control a real session; unverified capabilities remain disabled.

Source provenance: the archive manifest records the mini program workspace commit used to build this package. The release tag points to the matching distribution source in this repository.
