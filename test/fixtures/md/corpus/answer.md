## Why the build fails

The failure comes from **two** things working together: the cache key ignores `pnpm-lock.yaml`, and the
install step runs with `--frozen-lockfile`. See [the docs](https://pnpm.io/cli/install#--frozen-lockfile) and
the issue at https://github.com/pnpm/pnpm/issues/1234.

### What to change

1. Key the cache on the lockfile:
   ```yaml
   - uses: actions/cache@v4
     with:
       key: pnpm-${{ hashFiles('pnpm-lock.yaml') }}
   ```
2. Drop the stale entry once.
3. Re-run the job — it should pass.

| Step | Before | After |
|------|-------:|------:|
| install | 4m 10s | 38s |
| test | 2m | 2m |

> **Note:** nothing else needs to change. If it still fails, run `pnpm store prune` and try again.

- [x] Cache keyed
- [ ] Old cache dropped
  - ask in *#infra* first

That's it. Ask if anything is unclear!
