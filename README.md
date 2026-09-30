# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc23

Download the four assets attached to the [v0.6.0-rc23 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc23). Verify the ZIP against its `.sha256` file, then follow `README-RELEASE.txt` in the archive. The ZIP is 387002 bytes and its SHA-256 is `d907fd07c99a8ffa04b22faed7fa653e33d7fe659e881d7ce5a761a638221327`. Node.js 22 or newer is required. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

This preview fixes Qwen Code 0.24.6 native tool-result parsing. A normal registered profile has been verified through the mini program simulator, real development cloud and PC bridge for actual file reading and stopping an active process. Tool calls and results use the same native ID, and the page displays the confirmed success status. Unknown or malformed results remain diagnostic output. Existing Aider, OpenCode and Cursor controls are retained. These controls are not an OS sandbox. Third-party CLIs, account logins and device credentials are not bundled.

The current first-release scope is 25 Agent products. Windsurf/Devin and Comate are excluded candidates with capabilities disabled; their source and evidence remain available for later work. The V1.2 product release remains blocked by real-device, second-user and full 25-Agent acceptance tests.

Source provenance: the archive manifest records the mini program workspace commit used to build this package. The release tag points to the matching distribution source in this repository.
