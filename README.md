# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc21

Download the four assets attached to the [v0.6.0-rc21 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc21). Verify the ZIP against its `.sha256` file, then follow `README-RELEASE.txt` in the archive. The ZIP is 372873 bytes and its SHA-256 is `200c44dc83c240f33f8f4971cdb53ea81921eba04d559f62966d48e235d0a7a1`. Node.js 22 or newer is required. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

This preview explicitly disables editing, shell commands, network tools and subagents in the OpenCode profile recipe using a dedicated read-only primary agent. OpenCode create/read/stop has been verified through the mini program simulator, the real development cloud and the PC bridge; the effective tool configuration and forbidden-write probe agree. It retains the Cursor tool correlation, CLI preflight, bounded diagnostics, persistent terminal-event and controlled stop fixes. Third-party CLIs and account login are not bundled. The V1.2 product release remains blocked by real-device, second-user and full 27-Agent acceptance tests.

Source provenance: the archive manifest records the mini program workspace commit used to build this package. The release tag points to the matching distribution source in this repository.
