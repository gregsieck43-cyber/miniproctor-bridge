# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc22

Download the four assets attached to the [v0.6.0-rc22 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc22). Verify the ZIP against its `.sha256` file, then follow `README-RELEASE.txt` in the archive. The ZIP is 373308 bytes and its SHA-256 is `3e9b7ef9a231aeab405974584c7e36bdfe8a8d5d8c68b7bee9c44ce0db5e89d6`. Node.js 22 or newer is required. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

This preview enforces Aider readonly profiles with ask/dry-run and defaults native confirmation to denial. Remote task descriptions cannot dispatch native `/` or `!` commands. Normal editing remains available in other profile modes, without automatic Git commits. Aider/iFlow message IDs no longer consume event sequence numbers. Aider has been verified through the mini program simulator, real development cloud and PC bridge for file reading, controlled dirty-file editing and stopping an active process. It retains the OpenCode readonly recipe and Cursor tool correlation fixes. These controls are not an OS sandbox or a proven per-file allowlist. Third-party CLIs and account login are not bundled. The V1.2 product release remains blocked by real-device, second-user and full 27-Agent acceptance tests.

Source provenance: the archive manifest records the mini program workspace commit used to build this package. The release tag points to the matching distribution source in this repository.
