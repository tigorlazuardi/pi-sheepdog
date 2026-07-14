# Implementer notes — t3 attempt 4

- Removed `adapterArgs` from `WakeEntry` and from newly persisted wake entries.
- Decision: mapper args stay runtime-only from config resolution; state keeps only the selected adapter id, so credential/config path args cannot land in `state.json`.
- Check run: `npm --prefix /home/homeserver/projects/pi-sheepdog/.fleet/2026-07-14-sheepdog-dedicated-plugin/worktrees/task-d1-t3 run self-check -- mapper && npm --prefix /home/homeserver/projects/pi-sheepdog/.fleet/2026-07-14-sheepdog-dedicated-plugin/worktrees/task-d1-t3 run check` passed.
