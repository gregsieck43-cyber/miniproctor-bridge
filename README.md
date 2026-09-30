# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc25

Download the four assets attached to the [v0.6.0-rc25 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc25). Verify the ZIP against its .sha256 file, then follow README-RELEASE.txt in the archive. The ZIP is 387697 bytes and its SHA-256 is 95fde179a10143cc95871b9b147ce87017e5ddeed7b82af84633c26b794b1d53. Node.js 22 or newer is required. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

This preview preserves complete Continue CLI 1.5.47 JSON replies, including multi-line JSON, after successful exit and stdout drain. Failed, stopped, incomplete and oversized outputs remain explicit. Continue excludes all tools; model-authored JSON never becomes a tool approval. Earlier late-stop history protection and Cline local backend fixes remain included. Normal registered profile create/read/active-stop checks through the simulator, real development cloud and PC bridge cover twelve products. Third-party CLIs, account logins and device credentials are not bundled.

The first-release scope is 25 Agent products. Windsurf/Devin and Comate are excluded candidates with capabilities disabled; their source and evidence remain available. V1.2 remains blocked by real-device, second-user and full 25-Agent acceptance tests.

Source provenance: the archive manifest records workspace commit b00e0043ab389858bdeed36109b2321ad04a6823. The release tag points to matching distribution source.
