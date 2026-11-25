# Security policy

## Report a vulnerability

Report a security problem privately to the maintainers of this repository through GitHub's private vulnerability
reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for
a credential leak, a permission bypass, a path escape or any way to read another account's data.

Include what you did, what happened, and what you expected. A minimal reproduction helps most. Never include a real
access token, refresh token or personal data.

## What we will do

- Acknowledge the report within five working days.
- Tell you our assessment and the plan within ten working days.
- Credit you in the advisory unless you ask us not to.

## Scope

This plugin's code, its manifest and its documentation. Google's own services are outside this repository's scope:
report a problem with BigQuery itself to Google. The OpenCode host is outside it too: report a host problem to OpenCode.

## Supported versions

Only the latest release of the plugin is supported. The plugin refuses an OpenCode release outside
`>=2.4.1 <2.5.0` with `HOST_UNTESTED`.
