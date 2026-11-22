# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/h2967963512-afk/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/h2967963512-afk/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a small command-line patch tool: it reads one AI-written edit in unified diff, SEARCH/REPLACE, V4A or JSON form, finds the lines each edit names at the first of three matching tiers, and writes every change or none of them.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is a patch file, or `-` (or nothing) to read the patch from standard input. Options: `--format=unified|search-replace|v4a|json|auto`, `--check` (dry run: same output and exit code, no files written), `--strict` (exact line matching only). It prints what changed (`A`/`D`/`M`/`R` lines and `ok: N files`) or why it failed, and exits 0 on success, 1 when edits fail, 2 on usage, missing-patch, format or parse errors. Node 22, standard library only; see SPEC.md for the full contract.

<sub>Entered on [make.fun](https://make.fun/?ref=cj11yvbn&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
