# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc26

Download the four assets attached to the [v0.6.0-rc26 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc26). Verify the ZIP against its .sha256 file, then follow README-RELEASE.txt in the archive. The ZIP is 388834 bytes and its SHA-256 is 284c6afce3987ba6ce08003e614597f7518c00d87b8f313827aa99eaa387777a. Node.js 22 or newer is required. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

This preview freezes verified execution capabilities for registered profiles and legacy remote creation. Claude Code receives its required verbose flag and single-turn stdin closes after a real result. Claude thinking_tokens counters no longer flood the event queue; meaningful replies, results, usage and diagnostics remain available. Native Claude Code 2.1.286 and Codex CLI 0.155.1 were verified with a supported third-party provider. Pending append/approve capabilities remain closed. Continue JSON, late-stop history protection and Cline local backend fixes remain included. Normal registered profile create/read/active-stop checks through the simulator, real development cloud and PC bridge now cover fifteen products. Third-party CLIs, account logins and device credentials are not bundled.

The first-release scope is 25 Agent products. Windsurf/Devin and Comate are excluded candidates with capabilities disabled; their source and evidence remain available. V1.2 remains blocked by real-device, second-user and full 25-Agent acceptance tests.

Source provenance: the archive manifest records workspace commit 4f6600ff4366134d39760617082289f753a341bd. The release tag points to matching distribution source.
