# Contributing

The plugin follows [the plugin standard](https://github.com/we-the-rebel-alliance/plugin-contract/blob/master/docs/plugin-standard.md)
and [the contract](https://github.com/we-the-rebel-alliance/plugin-contract/blob/master/docs/contract.md). Read
[AGENTS.md](AGENTS.md) before changing anything.

## Set up

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` runs biome, the typecheck, the build, the unit tests, the generated-docs check, `plugin-kit check` (the
contract's gate, including T1 on OpenCode 2.4.1 and the unsupported-host refusal) and the pack check, in that order.

## Change a capability

1. Edit `capabilities` in `package.json`: a method, source or action, with its class, operations, accounts and cost.
2. Write the handler in `src/handlers/`; put the provider call in `src/provider/`.
3. Add a unit test, then record fixtures for two accounts:
   `npx plugin-kit record --account <alias>` redacts `fixtures/conformance.json` after the plugin's tests write it.
4. Run `npx plugin-kit docs` to regenerate the generated doc sections, then `npm run check`.
5. Describe the change in `docs/capabilities.md` and, if agents use it, in `skills/bigquery/SKILL.md`.

## Commits and releases

Conventional commits. The lead cuts `v0.0.x` releases on `master` with `npx plugin-kit release <version>`; CI publishes
the GitHub Release with `dist/`, `SHA256SUMS` and the conformance report. Never edit `dist/` by hand.
