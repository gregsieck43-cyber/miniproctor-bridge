# miniproctor bridge

PC bridge distributed with the 智能体遥知 WeChat mini program.

## Latest preview: v0.6.0-rc29

Download the four assets from the [v0.6.0-rc29 prerelease](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc29). Verify the ZIP using its .sha256 file and manifest.json, then follow README-RELEASE.txt. Node.js >=22 is required; Node24 is recommended. ZIP 422345 bytes. SHA-256: 23fe47e14abbfdc5e6b2ba2b477076300ae9bea19d44295969c2d7f9372379eb.

Includes the normal-profile DeepSeek Harness SDK worker, active-task stop and private runtime checks, Junie integration, and independent registrations for DSH, ZCode and WorkBuddy. DSH is pinned to official @deepseek-ai/dsh 0.2.0-rc.2 and its absolute JS entry on Windows Node 24.16.0. Only input text analysis and output readback are enabled; file and command tools remain unavailable. These permissions are not an OS sandbox. Set DEEPSEEK_API_KEY in the local bridge process environment; credentials and third-party CLIs are not bundled. The full DSH Web/Desktop repository build was not verified.

The agreed first-release scope is 28 Agent products. Normal registered profiles have passed simulator SDK to real cloud to bridge create/read/active-stop checks for 17/28 products, including DSH and Junie. ZCode and WorkBuddy remain independent, with all eight capabilities disabled. Phone, second-user, remaining-product and common concurrency/recovery/operations/platform gates remain incomplete. V1.2 remains NO-GO. This is a technical prerelease. Stable v0.5.1 and all previous tags and assets are preserved. The mini-program session profile-name fix is in the separate mini-program source and is not a PC archive component.

Archive source commit: 4bd04270ab5020a7ec027b6455fe254a3981e9b7. The release tag points to the matching distribution source.
