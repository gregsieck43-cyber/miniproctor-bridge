# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc15

Download the four assets attached to the [v0.6.0-rc15 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc15). Verify the ZIP against its `.sha256` file, then follow `README-RELEASE.txt` in the archive. The ZIP is 371614 bytes and its SHA-256 is `5c6f3561370e0e6ac4041280e1f47e8a77da758b9c8fe274002b142d00ae79e4`. Node.js 22 or newer is required. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

This preview improves the OpenHands SDK stop sequence so an accepted stop ends the session cleanly. It updates Qoder, Qoder CN, CodeArts Agent, Junie and Comate integration code, and excludes Python bytecode and cache folders from the archive. Other locally verified profiles remain included. Third-party CLIs and account login are separate from this bridge ZIP. The companion mini program also needs its protocol 0.3 routed-create fix. The V1.2 product release is still blocked by real-device and 27-Agent acceptance tests.

Source provenance: the archive manifest records the mini program workspace commit used to build this package. The release tag points to the matching distribution source in this repository.
