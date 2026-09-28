# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc11

Download the four assets attached to the [v0.6.0-rc11 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc11). Verify the ZIP against its `.sha256` file, then follow `README-RELEASE.txt` in the archive. The ZIP is 367228 bytes and its SHA-256 is `6f21434f209b4cb5e1e19c3e943b4fbec8474485e459ca31f747e154bcf31b18`. Node.js 22 or newer is required. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

This preview adds GitHub Copilot CLI 1.0.88 local create/read/stop on Windows through a read-only BYOK profile, with isolated per-task configuration and shared local cache. Copilot CLI and model credentials are installed separately. It retains OpenClaw 2026.9.6, Kimi Code 2.1.1, Cline 3.0.65, Continue 1.5.47, and Goose 1.52.0 local profiles. The V1.2 product release is still blocked by real device and 27 product Agent acceptance tests. A product appearing in the Agent catalog does not mean it can start or control a real session; unverified capabilities remain disabled.

Source provenance: the archive manifest records the mini program workspace commit used to build this package. The release tag points to the matching distribution source in this repository.
