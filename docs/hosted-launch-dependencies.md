# Hosted launch dependency fixes

The hosted launch review on 2026-09-04 found six registry advisories in the existing production
dependency tree. Exact overrides update two transitive packages without adding dependencies,
changing their purpose, or increasing the service's configured resources. The current Bun toolchain
is pinned to 1.3.14 and `bunfig.toml` retains `minimumReleaseAge = 259200` (72 hours).
Bun's [1.3.14 release notes](https://bun.com/blog/bun-v1.3.14), published May 13, 2026, report
an HTTP request-smuggling fix. Runtime, container, workflow, and local package requirements move
together; the earlier dependency audit below retains its original toolchain version.

| Package | Previous | Override | Registry publication time (UTC) | License |
| --- | --- | --- | --- | --- |
| `fast-uri` | 3.1.5 | 3.1.6 | 2026-08-23 01:42:00.349 | BSD-3-Clause |
| `qs` | 6.15.3 | 6.16.0 | 2026-08-29 23:50:15.803 | BSD-3-Clause |

Both releases exceed the minimum age. Publication timestamps come from the npm registry's `time`
metadata, checked with `bun info fast-uri time --json` and `bun info qs time --json`. The security
advisories were reported by `bun audit --json` against the committed lockfile before updating it.

## Purpose and runtime exposure

`fast-uri` parses and resolves URIs for Ajv, which the MCP SDK imports and instantiates as its
default JSON Schema validator. It is present in the hosted runtime through
`@modelcontextprotocol/sdk -> ajv -> fast-uri`. The fixes address IDN, IPv6, percent-decoding and
scheme canonicalization issues that can cause host confusion or SSRF in applications using the
affected URI results for outbound requests. Finding the package in this tree does not establish
that Murmur exposes an exploitable SSRF route. Updating it removes the known vulnerable parser
from the shipped runtime.

`qs` parses query strings and forms for the MCP SDK's Express/body-parser dependency tree.
Murmur serves hosted MCP through the SDK's Web Standard HTTP transport, and its OAuth form parser
uses `URLSearchParams`; these routes do not directly use Express or `qs`. The production install
still includes `qs`, so it is updated to remove the reported array-limit bypass and
attacker-controlled `isBuffer` denial-of-service issues from the distributed dependency tree.

The registry advisories are:

- `fast-uri`: [GHSA-5jgf-p345-68v8](https://github.com/advisories/GHSA-5jgf-p345-68v8),
  [GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc),
  [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf), and
  [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp).
- `qs`: [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) and
  [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g).

## Maintenance and removal

The upstream projects are [Fastify's fast-uri](https://github.com/fastify/fast-uri) and
[ljharb/qs](https://github.com/ljharb/qs). Their published fixes provide current maintenance
evidence; the overrides remain the Murmur maintainer's responsibility during dependency reviews.
Both selected versions satisfy the existing upstream dependency ranges.

Remove an override only when an intentional SDK/dependency upgrade selects a fixed version
without it, the regenerated lockfile contains no affected versions, `bun audit --json` passes,
and the repository's required verification gates pass. Removal changes no application API and
requires only manifest/lockfile maintenance and verification. Continue exact pinning and the
72-hour release-age policy during that change.

## Verification

On 2026-09-04, Bun 1.3.11 regenerated only these two package entries and their override records.
The frozen install then passed, installing the two updates, and `bun audit --json` returned `{}`
with exit status 0. The pre-update audit returned six advisories and exit status 1.

For an intentional dependency change, regenerate the lockfile with pinned Bun 1.3.14, then run
`bun install --frozen-lockfile` and `bun audit --json`. A clean audit establishes that the registry
reports no known vulnerabilities for those locked versions at verification time; it does not prove
absence of undisclosed defects.
The full hosted, portability and static gates remain required for release.
