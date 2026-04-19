---
name: build
description: Build the Chrome extension and reload instructions
---

Build the Murky Chrome extension:

1. Run `npm run build` in the project root
2. If the build fails, read the error and fix the issue
3. After a successful build, remind the user to reload the extension in `chrome://extensions`
4. If there are TypeScript errors, run `npm run typecheck` to get the full list first
