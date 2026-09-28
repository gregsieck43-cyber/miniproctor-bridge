# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc9

Download the four assets attached to the [v0.6.0-rc9 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc9). Verify the ZIP against its `.sha256` file, then follow `README-RELEASE.txt` in the archive. The ZIP is 363747 bytes and its SHA-256 is `bc4dd088e845f816338b3dbbf7e18f80fc1627d883983156b147e5864d9bd665`. Node.js 22 or newer is required. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

This preview adds Kimi Code CLI 2.1.1 local create/read/stop on Windows through a static read-only Agent profile. The verified tool set is Read, Grep, and Glob; write and shell tools are denied. Kimi Code and model credentials are installed separately. It retains Cline 3.0.65 text-only, Continue 1.5.47 text-only, and Goose 1.52.0 chat-only local profiles. The V1.2 product release is still blocked by real device and 27 product Agent acceptance tests. A product appearing in the Agent catalog does not mean it can start or control a real session; unverified capabilities remain disabled.

Source provenance: the archive manifest records the mini program workspace commit used to build this package. The release tag points to the matching distribution source in this repository.
