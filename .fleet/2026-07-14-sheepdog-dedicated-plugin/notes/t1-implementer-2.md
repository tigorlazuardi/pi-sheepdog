# Ticket 1 notes

- Inspected the existing partial diff and continued it instead of restarting from the missing prior handover.
- Kept Ticket 1 scoped to the rebrand: extension status key/path/command changes in `extensions/sheepdog.ts`, plus docs/README updates for the new `sheepdog` identity.
- Removed legacy slash commands from the extension, added `/sheepdog` and `/sheepdog config`, and clear the legacy `rate-limit-wakeup` footer key on refresh/startup/shutdown.
- Verified packaging after installing docs dependencies locally in the worktree so `npm run check` could build the docs site and run `npm pack --dry-run`.
