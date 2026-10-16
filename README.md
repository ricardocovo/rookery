# rookery

An issue intake repository with a GitHub Agentic Workflow that routes requests
to their owning application.

## Raven routing

When an issue is **opened in this repository** by an owner, member, or
collaborator, GitHub Copilot considers its title/body and the routing
documentation for these destinations:

- `ricardocovo/airbnb-admin-portal`
- `ricardocovo/focused-tube-demo`
- `ricardocovo/agentic-web-spec`

For a clear, single-repository match, the workflow:

1. Creates a copy with the original title/body, source link, author attribution,
   and `rookery:raven-arrived`.
2. Adds a destination-link comment to the original.
3. Labels the original `rookery:raven-sent` and closes it as **not planned**
   (routed elsewhere, not implemented).

Ambiguous, unrelated, insufficiently described, and multi-repository requests
remain open with `rookery:blind-raven`. Comments, assignees, milestones, and
existing labels are not copied. Unrelated labels on the original are preserved.
Required routing labels are created automatically when missing.

Issues from other authors, PRs, edits, and reopened issues do not trigger routing.
This workflow does not split requests, transfer issues, implement features, or
install workflows in destination repositories.

## Setup

1. Enable GitHub Actions in rookery and ensure Issues are enabled in all four
   repositories. The token owner must be able to manage issues and labels there.
2. Configure these **rookery repository Actions secrets**:

   | Secret | Purpose and minimum access |
   |---|---|
   | `COPILOT_GITHUB_TOKEN` | A supported Copilot engine credential with Copilot access. Use a separate credential from the routing PAT; see the [Copilot engine setup](https://github.github.com/gh-aw/reference/engines/). |
   | `ROOKERY_ROUTING_TOKEN` | Fine-grained PAT owned by an account with access to all four repositories. Select **only** rookery and the three destinations, grant **Issues: read and write**, and retain the automatically required metadata access. Private repository Contents access is not needed. |

   Enter token values directly in GitHub's secret settings; never put them in
   workflow files, issue bodies, or commits. Track token expiration and rotate
   before expiry. Keep the routing account identity stable: copied issues and
   backlinks are verified against the PAT's authenticated account. Changing that
   account requires manual reconciliation of any incomplete routes.

3. Review the public-safe [routing guide](.github/aw/raven-routing.md).
4. Include both the [workflow source](.github/workflows/raven-router.md) and its
   generated [lock file](.github/workflows/raven-router.lock.yml) on the default
   branch. Include the compiler-managed [action pins](.github/aw/actions-lock.json)
   as well. No additional deployment service is required.

The workflow is not deployed merely by creating these files locally. Live
routing requires the default-branch files, enabled Actions, valid credentials,
and a new eligible issue. This implementation does not set secrets, push
changes, change repository visibility, or create test issues automatically.

### Public/private documentation boundary

Rookery stays public. Every run reads the latest READMEs from the two public
destinations and the checked-in routing guide for all three destinations.
The only approved public description of the private Airbnb repository is:

> Features, bugs, and improvements for the Airbnb administration portal.

The workflow never fetches private destination documentation or source code.
If a public destination becomes private, its README is not read. Any request
requiring undocumented private context stays blind. Keep private information out
of the routing guide and intake issues: Actions logs and agent artifacts may be
visible to readers of this public repository.

### Credential and write boundaries

The agent is instructed to read prepared context and the routing guide using two
declared file-read commands. GitHub tools are disabled and network access is
denied. gh-aw also supplies its standard local text/file tools; filesystem
read-only isolation is not claimed. The writer checks out fresh, trusted code
in a separate job, not files modified by the agent. Context preparation uses the
source repository's read-only `GITHUB_TOKEN` and checks destination visibility
before reading public READMEs.

The cross-repository PAT is a newly required secret, used **only** in the
deterministic safe-output job. It is not provided to the agent, checkout, or
context preparation. The writer checks the source/event/author, allowlists the
three destinations, and re-reads source state before closing it. Missing, failed,
or warning threat-detection verdicts and failed agent executions block writes;
a detector explicitly skipped by gh-aw is accepted.

Issue creation uses gh-aw's supported `createIssue` helper for standard workflow
provenance. The setup helper is pinned to gh-aw v0.92.0's commit; compilation
pins the other GitHub Actions to commit SHAs in the lock file. No new
third-party integrations or outbound credential destinations are introduced.

## Failures and reruns

- If required public documentation is unavailable, the writer leaves the
  original open, labels it blind, and fails visibly. It does not guess from an
  empty or stale README.
- If copying, labeling, commenting, or verification fails, later steps stop;
  the source is not deliberately closed on an incomplete route. GitHub API
  timeouts can have uncertain outcomes: inspect the actual issues and rerun the
  workflow rather than creating a replacement manually.
- Use **Actions -> Raven issue router -> the failed run -> Re-run all jobs**.
  A provenance marker and authenticated author identify an existing copy across
  all three repositories, including closed copies. Reruns reuse it and its
  backlink even if the classifier chooses a different destination or blind.
  Per-issue concurrency prevents overlapping writers.
- Multiple matching copies, conflicting backlinks, a sent label without a
  verified copy, or an intake issue edited since its opened event require manual
  reconciliation. Changed issues are not routed from stale analysis.
- Engine/setup failures may prevent a decision and therefore leave the issue
  unchanged. Review the failed run; absence of a sent label is not success.
- For an ordinary blind decision, triage manually or open a clearer intake issue.
  Editing/reopening the old issue is intentionally not a retry trigger.

## Development and validation

Use Node.js 24+ and the GitHub Agentic Workflows CLI (`gh aw`, validated with
v0.92.0). No npm dependencies are required.

```powershell
node --test .github\scripts\raven-router.test.cjs
gh aw compile raven-router --strict
gh aw list --json
```

Edit the Markdown workflow source, not its generated lock file. Recompile after
changes and include the regenerated lock file. Review any compiler notices about
new secrets or actions; use `--approve` only after reviewing their scope.

The [handler tests](.github/scripts/raven-router.test.cjs) mock GitHub to verify
write ordering, labels, trust checks, content preservation, documentation errors,
pagination, and partial-success recovery. The routing guide includes
prompt-evaluation fixtures for classifier testing. Mocked tests and successful
compilation do **not** prove model accuracy or a live cross-repository round trip.
Live testing must be explicitly authorized because it creates and closes real
GitHub issues.