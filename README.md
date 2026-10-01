# miniproctor bridge

This repository contains the PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc28

Download the four assets attached to the [v0.6.0-rc28 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc28). Verify the ZIP against its .sha256 file, then follow README-RELEASE.txt. ZIP: 390997 bytes. SHA-256: fbebcdfcee477d2b2dcb872dac70cdda96f4a8e27dbd2e4b9a22cb1b1d1fb2d8. [v0.5.1](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.5.1) remains the stable rollback build.

Crash recovery now preserves the explicit target session of an interrupted stop, text or approval command in its durable unknown result envelope. Startup recovery and redelivery return the same business ACK, without executing the command again. An unknown create command retains its empty target and never fabricates a created session. The production regression covers all four command types. Controlled local restoration replayed 101 real durable result envelopes twice: 202 matching ACKs and zero executor calls. Real development-cloud data was encrypted and verified, but isolated CloudBase restoration, cloud GC and real deletion reapplication remain incomplete. The prior Windows stop ownership checks and other safety fixes remain included.

The first-release scope is 25 Agent products. Normal registered profile create/read/active-stop checks currently cover 15 products. Windsurf/Devin and Comate are excluded candidates with capabilities disabled. Phone, second-user, remaining-product safety/authentication, full concurrency/recovery/operations and platform acceptance remain incomplete. Windows two/four/eight-task concurrency slices were measured; they are not full T22 acceptance. This is a technical prerelease, and V1.2 remains NO-GO. Third-party CLIs, model keys, account logins and device credentials are not bundled. Node.js 22 or newer is required. Stable v0.5.1 and all earlier preview assets remain available.

Source provenance: the archive manifest records workspace commit 4e9a6b0acdaade646c763728144568ac9c69ed8f. The release tag points to matching distribution source.
