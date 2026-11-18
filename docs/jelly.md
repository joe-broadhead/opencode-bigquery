# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this package's `package.json` as
JSON, without loading the plugin, when a person reviews the exact version, and uses it as follows.

Jelly names the plugin **BigQuery** (`jelly.title`), with the package name and version beneath, the one line in
`jelly.summary`, and the mark in `jelly.icon` (`assets/icon.svg`, shipped in the package). The mark is the family's own
tile, not Google's logo.

## Tools and permissions

22 tools are declared (15 read-only): the nineteen tools, two reads that are tools RPC methods only, `bigquery.saved_list`
(a source's set-up lists the saved queries with their SQL and estimates) and `bigquery.probe` (names the signed-in
account for sources), and one permission-only read, `bigquery.read`, which a source's read asserts on each BigQuery
operation it uses, as the source contract requires, so turning one operation off is honoured. Every action the plugin asserts is declared, and every read is `readOnly`, so at Read only every
read runs, the scripts' and sources' reads included. A read left out of the list would be off at Read only.
`test/unit/jelly.test.ts` keeps `jelly.tools` equal to the action table (`src/domain/actions.ts`), and checks each
declared effect against the plugin's own default rules.

One action is a run-time ask, `bigquery.uncapped_read` (`jelly.asks`): `bigquery_query({ planId })` asserts it before
it runs a read the byte cap cannot bound, such as one over a table with row access policies or an external table. With
Jelly's rules it runs without asking at Allowed, and asks at Ask before changes and at Read only, as the block below
says. At Allowed such a read is then bounded only by its 120-second job limit (`uncappedTimeoutSeconds`) and your
budget, if you set one: BigQuery bills what it actually reads, which can be more than the byte cap. Choose Ask before
changes to be asked first. In local OpenCode the plugin's own default rules ask for it at `all` and `ask-changes` and
deny it at `read-only`. A script cannot answer an ask, so the tools RPC refuses such a plan from a script.

The family's shared rules, word for word from Jelly's guide:

<!-- family-block:start -->
- At Allowed (`all`), the default, every tool runs without asking, declared or not, whatever its `effect`.
- At Ask before changes (`ask-changes`), a `readOnly` tool runs, and every other tool asks first, including a tool this plugin does not declare.
- At Read only (`read-only`), a `readOnly` tool runs, and every other tool is off, including a tool this plugin does not declare.
- A declared `effect` of `allow` changes nothing: the tool follows the access choice and its `readOnly`.
- A declared `effect` of `ask` makes the tool ask at Ask before changes, even when it is `readOnly`, and changes nothing at Allowed or Read only.
- A declared `effect` of `deny` turns the tool off at Ask before changes and at Read only, and changes nothing at Allowed.
- An action listed in `asks` asks first at Ask before changes and at Read only, and never at Allowed.
- A tool named with one `*`, such as another account's `plaud-*.get_file`, follows the same rules as a tool named in full.
- A choice the person makes for one tool wins over the access choice and the declared `effect`.
- jelly leaves out a key it does not know at the top level of the `jelly` block, and reads the rest.
- jelly refuses the plugin for a key it does not know inside anything it reads, such as a tool, a sign-in or a setting.
- jelly refuses the plugin, with one plain line, when `requires` names a field or a feature it does not read.
<!-- family-block:end -->

## Skills

Declared: `opencode-bigquery` and `opencode-bigquery-sql`.

## Views and scripts

`jelly.views` and `jelly.rpc` are empty. Scripts reach the reads through the tools RPC, `google-cloud.bigquery.tools`
([Scripting](scripting.md)).

## Sources

The `sources` block declares two sources for Memory, `bigquery.jobs` (your finished jobs, free) and `bigquery.saved`
(a saved query's result as a table, billed under a cap of 1 GiB per read), read through the tools RPC.

## Signing in

`jelly.signIns` declares one sign-in, `google-bigquery`, the plugin's own integration `bigquery-<alias>` with Jelly's
`google` host client and its relay. Its scopes are every scope either level requests: `openid`, `userinfo.email`,
`bigquery`, and `bigquery.insertdata`, the Read and write level's marker. The account's description carries the
disclosure of what a Read token can do.

## Cost

`jelly.cost`, shown on the review before the plugin installs: Google bills queries to your billing project, on demand
about $6.25 per TiB scanned with the first TiB a month free, and cached reads are free; each query is estimated and
capped (10 GiB unless raised, and a saved query at most 1 GiB billed per read unless you raise it); AI/ML functions,
Python UDFs and remote functions bill outside that cap and need a plan.

The `bigquery.saved` source declares its price as $6.25 per TiB billed. Its conditions (on-demand pricing; at most
1 GiB billed per read unless you raise it; cached reads are free) are stated here and in the cost line rather than in
the `sources` block, because the source contract's v0.1.x consumers refuse a price's `conditions` and `min`; they
return to the block once Jelly and Memory read source-contract v0.2.0. `jelly.admin` names what an admin grants first:
BigQuery Job User on a billing project, Data Viewer on the datasets read, and this OAuth client where an organisation
restricts Google sign-ins.

## Settings

`jelly.contributes.settings` declares `access`, a choice of three: **Allowed** (`all`, the default), **Ask before
changes** (`ask-changes`) and **Read only** (`read-only`), with Jelly's own line for each.

## Versions

Jelly's curated catalogue pins an exact version. The declaration test runs the shared kit, `test/support/jelly-kit.ts`,
and Jelly's setting rules, `test/support/jelly-settings.ts`; `scripts/check-copies.mjs` keeps both equal to the copies
every plugin carries.
