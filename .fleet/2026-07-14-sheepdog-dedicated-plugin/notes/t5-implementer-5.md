# t5 implementer attempt 5

- Fixed the spec retry only: auto-detected and migrated wake entries no longer populate `originalSource`.
- Kept lock/temp-file/rename state handling untouched.
- Updated the state self-check to assert `originalSource` stays unset for migrated/auto entries and remains preserved only for manual overrides that already carry it.
- `npm run self-check -- state && npm run check` passed.
