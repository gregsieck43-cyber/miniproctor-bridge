# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc7

Download the four assets attached to the [v0.6.0-rc7 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc7). Verify the ZIP against its `.sha256` file, then follow `README-RELEASE.txt` in the archive. The ZIP is 362631 bytes and its SHA-256 is `d9f6d3cf65537d0598e7f233dd86d69d21d8e073af5f26f446e82bc0b1dc9902`. Node.js 22 or newer is required. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

This preview adds Continue CLI 1.5.47 local create/read/stop on Windows in text-only mode, with every CLI tool excluded. It retains Goose 1.52.0 local create/read/stop in chat-only mode. The V1.2 product release is still blocked by real device and 27 product Agent acceptance tests. A product appearing in the Agent catalog does not mean it can start or control a real session; unverified capabilities remain disabled.

Source provenance: the archive manifest records the mini program workspace commit used to build this package. The release tag points to the matching distribution source in this repository.
