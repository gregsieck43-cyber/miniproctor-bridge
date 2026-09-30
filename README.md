# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc20

Download the four assets attached to the [v0.6.0-rc20 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc20). Verify the ZIP against its `.sha256` file, then follow `README-RELEASE.txt` in the archive. The ZIP is 372409 bytes and its SHA-256 is `07b2305c7603f0644a9ed34c7ed9a2bb684677c7a76616a78a6019ba19bc1c7f`. Node.js 22 or newer is required. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

This preview correlates Cursor tool start/completion events using the native call ID. It retains the previous CLI preflight, profile version, bounded diagnostics, persistent terminal-event and controlled stop fixes. Cursor create/read/stop has now been verified through the mini program simulator, the real development cloud and the PC bridge. The companion mini program source also updates tool-card status when the corresponding result arrives; that UI code is separate from this bridge ZIP. Third-party CLIs and account login are not bundled. The V1.2 product release remains blocked by real-device, second-user and full 27-Agent acceptance tests.

Source provenance: the archive manifest records the mini program workspace commit used to build this package. The release tag points to the matching distribution source in this repository.
