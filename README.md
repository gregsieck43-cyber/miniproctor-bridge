# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc8

Download the four assets attached to the [v0.6.0-rc8 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc8). Verify the ZIP against its `.sha256` file, then follow `README-RELEASE.txt` in the archive. The ZIP is 363128 bytes and its SHA-256 is `67819dfbb682423dd239b6ed40db7757b36cf994c9c8f89bf835c5f458c84d4c`. Node.js 22 or newer is required. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

This preview adds Cline CLI 3.0.65 local create/read/stop on Windows with tool auto-approval disabled in non-interactive mode. Tool calls needing approval are denied, so the verified path provides text answers only. It retains Continue 1.5.47 text-only and Goose 1.52.0 chat-only local profiles. The V1.2 product release is still blocked by real device and 27 product Agent acceptance tests. A product appearing in the Agent catalog does not mean it can start or control a real session; unverified capabilities remain disabled.

Source provenance: the archive manifest records the mini program workspace commit used to build this package. The release tag points to the matching distribution source in this repository.
