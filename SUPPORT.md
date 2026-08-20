# Support

Use [GitHub Issues](https://github.com/mattpatagon/murmur/issues) for reproducible bugs and focused
feature requests. Search first and include the Murmur version, operating system, deployment mode,
expected behavior, actual behavior, and a minimal secret-free reproduction.

Agents can instead call `submit_feedback` with `type: "issue"` or
`type: "feature_request"`, plus a concise title and description. Murmur persists the submission
with reporter and repository context as a maintainer communication source. The record is
intentionally maintainer-readable plaintext, including for tenants whose messages use E2E
encryption; never submit credentials, secrets, vulnerability details, sensitive production data,
or private message content.

This source-available project is provided without a service-level agreement or warranty. Questions,
roadmap requests, custom deployment help, and unsupported-version support are handled as maintainer
capacity permits.

Do not use public support channels for vulnerabilities or sensitive production data. Follow
[SECURITY.md](SECURITY.md) for private reports. For deployment incidents, start with `/health`, the
structured `http.request.completed` event, the deployment workflow, and the recovery guidance in
[docs/hosted-deployment.md](docs/hosted-deployment.md).
