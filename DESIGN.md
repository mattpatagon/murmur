# Design System — Murmur

## Product context

Murmur is a durable coordination layer for AI coding agents. It gives Claude Code, Codex,
and other MCP clients a shared way to find peers, send messages, and leave repository notices
across sessions, worktrees, and machines. Its durable inbox is authoritative; a notification
asks a client to read that inbox again.

This is the public institutional website, in the existing Murmur repository. Its job is to
explain the product, demonstrate the coordination model, identify who benefits, and help a
visitor connect their first agent. It is not an authenticated application or an admin console.

Primary audience: developers running more than one coding agent. Secondary audiences: teams
sharing repositories and platform engineers evaluating hosted or self-hosted infrastructure.
Visitors understand development tools but should not need to know MCP terminology to understand
the first screen. Expand MCP as Model Context Protocol on the explanatory page.

**The one thing to remember:** your agents can work separately and still stay in sync.

The source of truth for product claims is README.md, docs/architecture.md,
docs/self-service-onboarding.md, docs/e2ee-protocol.md, and the public setup MCP contract.
Never invent adoption metrics, customer logos, testimonials, prices, compliance certifications,
latency guarantees, automatic conflict prevention, or a guarantee that idle agents wake up.

## Aesthetic direction

- Direction: editorial clarity with the precision of a small engineering instrument.
- Decoration: intentional. Fine rules, a dotted message route, and a restrained dot-based mark
  express connections. Every large visual explains the product.
- Mood: calm, capable, human, and specific. Infrastructure can feel approachable without losing
  technical credibility.
- Palette: warm paper and forest ink, with a sharp citron accent. Dark surfaces are reserved for
  the message demonstration and code examples to establish a strong reading rhythm.
- Layout: asymmetric hero, large confident type, generous section intervals, numbered explanatory
  rows, and visible code. Avoid repeating interchangeable cards throughout the page.
- Illustration: use actual HTML/SVG geometry and readable sample messages. Client identity uses only
  official vendor-provided marks with recorded provenance. No stock photography, robot mascots,
  abstract 3D objects, generic gradients, or generic stand-in client icons.

Familiar choices: clear navigation, a prominent setup action, copyable commands, public setup
instructions, readable security information, and responsive layouts. These let developers evaluate a
tool quickly.

Deliberate risks:

1. A paper-colored institutional site in a category often represented by dark consoles. This
   makes the product welcoming and lets the dark demo become a focal point. It gives up the
   appearance of a full-screen developer dashboard.
2. A typographic, directional message exchange instead of an expansive network animation. This
   teaches the durable inbox model and gives Murmur a recognizable visual. It gives up spectacle
   in favor of a comprehensible example.
3. No fabricated social proof or pricing grid. Confidence comes from explaining the mechanism
   and letting visitors inspect a working setup path without a source checkout.

## Information architecture

| Route | Purpose | Required content and action |
| --- | --- | --- |
| `/` | Understand and evaluate | What Murmur does, interactive handoff, audiences, capabilities, setup preview, FAQ |
| `/how-it-works/` | Understand the mechanism | Register, discover, send, persist, reread, acknowledge; notices vs broadcasts; boundaries |
| `/get-started/` | Connect a first agent | Claude Code, Codex, OpenCode, Cursor, Pi, inherited environments, generic MCP instructions; public setup, restart, guide prompt, next steps |
| `/security/` | Evaluate trust | Tenant credentials, operator boundary, retention, optional E2EE and metadata, security reporting |
| `/license/` | Inspect terms | Full repository license text and accurate source-access expectations |
| `/404.html` | Recover from a bad link | Plain explanation with home and setup links, real 404 response |

Navigation: How it works, Get started, Security. The primary button says “Connect your
agents” and leads to `/get-started/`. Secondary actions say exactly what they open. Use the
repository documentation for detailed operator procedures instead of copying an entire manual.
Footer includes how it works, public setup instructions, license, security, and a short product
description. Repository references explain that access may be required.

Homepage narrative:

1. Small category label, “Independent agents. Shared context.”, plain explanation, setup action.
2. A handoff example with named agents, repository/branch context, durable inbox, and delivery
   status. The example is explicitly labeled a demo. Visitor-controlled steps show why the inbox
   survives a disconnected recipient.
3. Compatibility catalog with official marks for Claude Code, Codex, OpenCode, Cursor, Pi,
   Conductor, and Orca, plus a clear path for any other MCP client.
4. The coordination problem and three numbered capabilities: find peers, exchange context, and
   leave durable repository state. Include direct/broadcast/notices distinctions.
5. Audience rows for solo developers with multiple agents, engineering teams, and platform teams.
6. A setup excerpt and link to complete instructions.
7. Deployment choice: hosted HTTP, local SQLite, or shared PostgreSQL. State what each is for.
8. FAQ with honest boundaries: notifications, encryption, retention, and MIT license.
9. Final setup action and footer.

## Typography

- Display, body, and UI: DM Sans variable, self-hosted Latin WOFF2. Its compact curves make large
  headlines distinctive while preserving reading comfort in explanatory copy.
- Code, technical labels, counters, and diagram metadata: IBM Plex Mono, regular Latin WOFF2.
  It reads as an engineering annotation and supports aligned technical values.
- Fallback: sans-serif for DM Sans; monospace for IBM Plex Mono. Fallback fonts are resilience,
  not the visual identity.
- Loading: package-managed font assets bundled at build time, `font-display: swap`, no third-party
  font request. Preload the primary Latin face only if measurements justify it.
- Display: 76px desktop, fluid down to 44px mobile; weight 500; line height 1.04; tracking -0.055em.
- Page heading: 64px down to 40px; weight 500; line height 1.08; tracking -0.045em.
- Section heading: 44px down to 32px; weight 500; line height 1.12; tracking -0.04em.
- Subheading: 24px; weight 500; line height 1.3; tracking -0.025em.
- Body: 18px with 1.65 line height; supporting text 16px with 1.6 line height.
- UI: 14–16px; weight 500 or 600. Technical labels: 11–12px with moderate tracking.
- Reading measure: explanatory paragraphs generally stay under 65 characters per line.
- Use tabular numerals for step counters. Avoid all-caps paragraphs and tiny footnotes.

## Color

| Token | Value | Role |
| --- | --- | --- |
| `paper` | `#f5f4ed` | Main background |
| `surface` | `#ffffff` | Raised light surfaces, command output |
| `ink` | `#193a32` | Headings, main text, primary buttons |
| `muted` | `#52645b` | Secondary text on paper |
| `line` | `#d6dbce` | Nonessential borders and separators |
| `accent` | `#d5f478` | Highlights, dark-surface actions, dot mark |
| `night` | `#132d27` | Demo and code background |
| `night-muted` | `#b4c8bd` | Secondary text on dark surfaces |
| `success` | `#326346` | Success text on light surfaces |
| `warning` | `#805400` | Warning text on light surfaces |
| `error` | `#a32e35` | Failure text on light surfaces |
| `info` | `#225c7b` | Informational text on light surfaces |

Text uses ink on paper, white/paper on night, or ink on accent. Citron is a fill/accent and never
small text on white. Verify WCAG AA contrast (4.5:1 for body, 3:1 for large text and controls).
Color always has a text or shape counterpart for delivery state and errors.

Theme strategy: one carefully composed light identity with dark content panels. Honor the
browser's user accessibility settings; do not infer a dark site from the OS theme. A future dark
theme would need redesigned surface contrast, not automatic inversion.

## Spacing and layout

- Base unit: 4px. Scale: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128px.
- Density: generous marketing sections, comfortable prose, compact technical labels.
- Content max-width: 1200px; page gutters 48px desktop, 24px tablet, 20px mobile.
- Desktop: 12-column mental grid; hero approximately 6/6 with a 48px gap. Prose pages use a
  narrower reading column and an optional compact aside.
- Tablet below 960px: reduce gaps, stack the hero and explanatory split sections.
- Mobile below 640px: single column, compact header, no horizontally overflowing page content.
  Code may scroll within its labeled block; no other content should require horizontal scroll.
- Section padding: 96px desktop, 64px tablet, 48px mobile. Use thin separators to mark transitions.
- Radii: 4px technical tags, 8px buttons/code, 12px demo panel. Full radius only for dots and status
  indicators. Avoid rounding every block into a pill.
- Shadows: none except a subtle grounded demo shadow if needed; borders establish structure.
- Header: static document flow; keyboard skip link precedes navigation. Mobile uses a native
  disclosure with real links. Ensure large navigation targets without overlay complexity.

## Components and states

- Brand: lowercase “murmur” wordmark with a compact six-dot signal mark. The name remains text.
  Decorative SVG is hidden from assistive technology.
- Buttons: solid ink primary on paper, citron primary on night, outlined secondary. Minimum
  target height 44px; hover adjusts fill; focus has a visible 3px outline with offset.
- Links: prose links underlined, navigation visually separate; external links remain understandable
  without relying on an arrow alone. Keep browser-native link behavior.
- Setup selector: React progressively enhances pre-rendered default instructions. Use labeled
  buttons with pressed state for host choices; command and explanatory copy change together.
  Without JavaScript, default setup and generic MCP details remain readable.
- Copy action: explicit “Copy command”; confirmation through a polite status region. If clipboard
  access fails, show “Select and copy the command below.” Never claim success on a failed write.
- Handoff demo: visitor-controlled, deterministic, no backend calls, no typing animation. The
  initial rendered example is meaningful before hydration. States: agent sends; message is stored
  while recipient is away; recipient reads on return. Replay returns to the first state.
- FAQ: native `details`/`summary`, keyboard accessible, first-principles answers, no custom widget.
- Errors: explain a failed local action in plain language. Do not surface arbitrary exceptions.
- No signup form, token input, chat widget, tracking prompt, or admin actions on this public site.

## Motion and accessibility

- Motion: minimal and functional. 150ms ease-out for color and border transitions. Demo state
  changes are immediate or use a short opacity transition. No auto-advancing animation.
- Reduced motion: remove transitions and smooth scrolling with `prefers-reduced-motion`.
- Semantic landmarks, one h1 per page, ordered heading levels, descriptive page titles.
- Every interaction works with keyboard alone. Focus is visible and never trapped.
- Announce copy feedback and demo status politely; do not repeatedly announce decorative text.
- Respect zoom to 200%, test 320px/375px/768px/1440px viewports, and keep controls reachable.
- SVG diagrams need equivalent readable HTML. Important content is not baked into an image.

## Technical delivery and performance

Astro statically generates the site in `website/`. React and TypeScript power only the setup
selector and handoff demo. Tailwind CSS provides design tokens and utility styling. Shared CSS
defines the small component vocabulary. The API package and existing Cloud Run deployment retain
their distinct responsibility.

Build and serve static assets on Cloudflare Pages. Use GitHub Actions with exact pinned tooling,
the frozen Bun lockfile, a build/validation gate for pull requests, and automatic production
deployment on pushes to `main`. Credentials exist only in CI/deployment environment secrets.
No credential may enter a public Astro variable or browser bundle. Preview and production deploys
must identify the Git revision. Use a real 404 page, security headers, canonical URLs, sitemap,
robots.txt, favicon, and a generated social preview that matches the brand.

Target: under 100KB compressed initial JavaScript, under 250KB fonts total, no render-blocking
third-party services, and no layout shifts from font loading or demo transitions. Default content
must be present in HTML. Audit actual build artifacts, broken internal links, mobile layout,
interactive state changes, browser console, and deployed response headers.

## Writing and product boundaries

Use short sentences, concrete verbs, and inspectable examples. Explain outcomes before tool
names. Say “open source under the MIT License” and link to the project source. Messages
are retained for 30 days, not forever. Notices have their own lifecycle and create no inbox
delivery. Hooks check during host activity and do not independently wake idle agents.

The initial public setup connection is read-only and needs no credential or local package.
Actual messaging requires a hosted credential or self-hosted storage. Administrative consent is
human-controlled. Optional E2EE requires tenant enforcement and local endpoints; metadata remains
visible. Do not claim default E2EE, invisible metadata, or repository-specific isolation.

## Decisions log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-09-05 | Created before implementation with gstack design-consultation | Product and audience derived from repository evidence; user delegated design decisions |
| 2026-09-05 | Paper/forest/citron with DM Sans and IBM Plex Mono | Approachable public identity with clear technical annotations |
| 2026-09-05 | A working handoff example is the principal visual | Teach the durable inbox model through a concrete interaction |
| 2026-09-05 | Static Astro site and two React islands | Fast, inspectable pages with useful progressive enhancement |
| 2026-09-05 | Cloudflare Pages through GitHub Actions | User explicitly requested Pages and automatic deployment from this repository |
| 2026-09-05 | Public setup MCP is the primary conversion path | Current supported onboarding requires no secret in the website |
| 2026-09-06 | Expanded the client catalog with official marks | Show the major directly managed and inherited agent environments without implying native support where an adapter or launched agent provides it |
