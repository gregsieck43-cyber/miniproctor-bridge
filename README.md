# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc10

Download the four assets attached to the [v0.6.0-rc10 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc10). Verify the ZIP against its `.sha256` file, then follow `README-RELEASE.txt` in the archive. The ZIP is 365766 bytes and its SHA-256 is `12125395e45367bf8ec1580d93eb403b97c0af1ca84f56105ee0b85b2877015f`. Node.js 22 or newer is required. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

This preview adds OpenClaw 2026.9.6 local create/read/stop/usage on Windows through an embedded `agent exec` profile with all tools denied and per-task state. OpenClaw and model credentials are installed separately. It retains Kimi Code 2.1.1, Cline 3.0.65, Continue 1.5.47, and Goose 1.52.0 local profiles. The V1.2 product release is still blocked by real device and 27 product Agent acceptance tests. A product appearing in the Agent catalog does not mean it can start or control a real session; unverified capabilities remain disabled.

Source provenance: the archive manifest records the mini program workspace commit used to build this package. The release tag points to the matching distribution source in this repository.
