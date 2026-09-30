# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc24

Download the four assets attached to the [v0.6.0-rc24 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc24). Verify the ZIP against its `.sha256` file, then follow `README-RELEASE.txt` in the archive. The ZIP is 387279 bytes and its SHA-256 is `cebf15a07f604d40287438de4f5e96821f4a701494ba0f82b8227ff9b8d084f0`. Node.js 22 or newer is required. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

This preview fixes failure results for commands arriving after their target session has exited, preserving the existing event history. Cline 3.0.65 accepts task text without whitespace and uses a local SDK backend that exits with the CLI. Cline provider/model configuration belongs in its local sandbox state (CLINE_SANDBOX_DATA_DIR); credentials remain local. Normal registered profile create/read/active-stop checks through the simulator, real development cloud and PC bridge cover nine products. These controls are not an OS sandbox. Third-party CLIs, account logins and device credentials are not bundled.

The current first-release scope is 25 Agent products. Windsurf/Devin and Comate are excluded candidates with capabilities disabled; their source and evidence remain available for later work. The V1.2 product release remains blocked by real-device, second-user and full 25-Agent acceptance tests.

Source provenance: the archive manifest records the mini program workspace commit used to build this package. The release tag points to the matching distribution source in this repository.
