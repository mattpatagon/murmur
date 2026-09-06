# Production verification log access

The real-window production verifier reads Cloud Run completion and platform-request metadata.
Its deployment identity must not receive project-wide log access merely to verify one service.

## Fixed query scope

Every verifier log query explicitly selects:

- project: the validated `PROJECT_ID`;
- log bucket location: `global` (independent of the Cloud Run `REGION`);
- log bucket: `_Default`;
- log view: the validated `SERVICE` name.

For service `murmur-mcp`, the view is
`projects/PROJECT_ID/locations/global/buckets/_Default/views/murmur-mcp`.
The view must include both application logs and Cloud Run request logs for that service and region.
If logs are routed elsewhere, this deployment contract must be updated and verified explicitly;
the verifier does not discover other buckets or fall back to a broader scope.

The view filter is the cloud-enforced boundary. The verifier additionally filters by service,
region, exact serving revision, observation window, and expected request/session correlations.
Its two-row limits, output projections, safe errors, and absolute deadlines remain unchanged.

## Authorized operator setup

These commands create a log view and change that view's IAM. Obtain the resource owner's
approval first. Set `PROJECT_ID`, `REGION`, `SERVICE`, and `DEPLOY_SERVICE_ACCOUNT` to the reviewed
deployment values; they are identifiers, not credentials. The commands below are POSIX operator
examples, not portable package entry points.

First inspect existing views and the deployment identity's inherited permissions. Do not replace
an existing view or remove an existing binding without reviewing its users and purpose.
The identity should not already have broader inherited log-reader permissions.

```bash
gcloud logging views list --project "$PROJECT_ID" --location global --bucket _Default \
  --format='json(name,filter)'
```

Create the service-named view with a service-and-region filter. Flexible log-view filters support
resource labels; see Google's [log-view documentation](https://cloud.google.com/logging/docs/logs-views).
This view selects existing entries; it does not create a new bucket or copy retained logs.

```bash
gcloud logging views create "$SERVICE" --project "$PROJECT_ID" \
  --location global --bucket _Default \
  --description='Service-scoped production verification' \
  --log-filter="resource.type=\"cloud_run_revision\" AND resource.labels.project_id=\"$PROJECT_ID\" AND resource.labels.location=\"$REGION\" AND resource.labels.service_name=\"$SERVICE\""

gcloud logging views add-iam-policy-binding "$SERVICE" --project "$PROJECT_ID" \
  --location global --bucket _Default \
  --member="serviceAccount:$DEPLOY_SERVICE_ACCOUNT" \
  --role=roles/logging.viewAccessor --condition=None
```

Bind `roles/logging.viewAccessor` to this **view**, not the project. Do not grant
`roles/logging.viewer`, Logging Admin, Owner, or service-account impersonation to the verifier.
If view creation or the grant is denied, stop and have an authorized operator apply the reviewed
change; never substitute a broader role or an unfiltered view.

Read back the view filter and binding independently:

```bash
gcloud logging views describe "$SERVICE" --project "$PROJECT_ID" \
  --location global --bucket _Default --format='json(name,filter)'
gcloud logging views get-iam-policy "$SERVICE" --project "$PROJECT_ID" \
  --location global --bucket _Default --format=json
```

Finally run the protected, main-only real-window workflow documented in
[hosted deployment](hosted-deployment.md). Its preflight must pass as the actual deployment
identity before it provisions a canary. A successful administrator query does not prove the
deployment identity's access. The full 55-minute observation and post-observation log checks
remain mandatory; a view grant alone is not production verification evidence.

## Public repository safety

Only trusted main-branch jobs may obtain production credentials through the configured OIDC
trust. Pull-request jobs must not receive production credentials or log-view access.
Treat public Actions output and artifacts as public: never emit raw log entries, message content,
tokens, raw session identifiers, or subprocess stderr. The verifier prints only its allowlisted
verification result; creating a log view does not make cloud logs publicly readable.
