const SOURCE = 'ricardocovo/rookery';
const DESTINATIONS = Object.freeze([
  'ricardocovo/airbnb-admin-portal',
  'ricardocovo/focused-tube-demo',
  'ricardocovo/agentic-web-spec',
]);
const PUBLIC_REPOS = Object.freeze(DESTINATIONS.slice(1));
const ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const LABELS = Object.freeze({
  arrived: { name: 'rookery:raven-arrived', color: '0e8a16', description: 'Routed here from rookery' },
  sent: { name: 'rookery:raven-sent', color: '1d76db', description: 'Copied to its owning repository' },
  blind: { name: 'rookery:blind-raven', color: 'fbca04', description: 'Needs human routing or restored documentation access' },
});

function repoParams(fullName) {
  const [owner, repo] = fullName.split('/');
  return { owner, repo };
}

function eligible(context) {
  return `${context.repo.owner}/${context.repo.repo}` === SOURCE
    && context.eventName === 'issues'
    && context.payload.action === 'opened'
    && !context.payload.issue?.pull_request
    && ASSOCIATIONS.has(context.payload.issue?.author_association);
}

async function publicDocumentation(github) {
  const results = await Promise.allSettled(PUBLIC_REPOS.map(async (name) => {
    const params = repoParams(name);
    const { data: repository } = await github.rest.repos.get(params);
    if (repository.private !== false) {
      throw new Error('Repository is not public; refusing to read its documentation');
    }
    const { data } = await github.rest.repos.getReadme(params);
    if (data.encoding !== 'base64' || typeof data.content !== 'string') {
      throw new Error('README was not returned as base64 content');
    }
    const text = Buffer.from(data.content, 'base64').toString('utf8');
    if (!text.trim() || Buffer.byteLength(text) > 65536) {
      throw new Error('README is empty or exceeds the 64 KiB routing limit');
    }
    return { repository: name, path: data.path, sha: data.sha, text };
  }));
  const documents = [];
  const errors = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      documents.push(result.value);
    } else {
      const error = result.reason;
      errors.push(`${PUBLIC_REPOS[index]}: ${error.status ? `GitHub HTTP ${error.status}` : error.message}`);
    }
  }
  return { documents, errors };
}

async function prepareContext({ github, context }) {
  if (!eligible(context)) throw new Error('Ineligible raven routing event');
  const issue = context.payload.issue;
  return {
    issue: { title: issue.title, body: issue.body ?? '' },
    privateRepositoryPolicy: 'Use only the approved Airbnb description in the routing guide.',
    ...await publicDocumentation(github),
  };
}

function decisionFrom(output) {
  if (!Array.isArray(output?.items) || output.items.length !== 1) {
    throw new Error('Exactly one route_raven decision is required');
  }
  const item = output.items[0];
  if (!item || item.type !== 'route_raven'
    || ![...DESTINATIONS, 'blind'].includes(item.destination)
    || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 1000
    || typeof item.evidence !== 'string' || !item.evidence.trim() || item.evidence.length > 2000) {
    throw new Error('Invalid raven destination, reason, or documentation evidence');
  }
  return item;
}

function hasLabel(issue, label) {
  return issue.labels.some((entry) => (typeof entry === 'string' ? entry : entry.name) === label);
}

async function ensureLabel(github, repository, label) {
  const params = { ...repoParams(repository), name: label.name };
  try {
    await github.rest.issues.getLabel(params);
  } catch (error) {
    if (error.status !== 404) throw error;
    try {
      await github.rest.issues.createLabel({ ...repoParams(repository), ...label });
    } catch (creationError) {
      if (creationError.status !== 422
        || !creationError.response?.data?.errors?.some((entry) => entry.code === 'already_exists')) {
        throw creationError;
      }
      // Concurrent issues may provision the same repository label.
      await github.rest.issues.getLabel(params);
    }
  }
}

async function addLabel(github, repository, issue, label) {
  await ensureLabel(github, repository, label);
  if (!hasLabel(issue, label.name)) {
    await github.rest.issues.addLabels({
      ...repoParams(repository), issue_number: issue.number, labels: [label.name],
    });
  }
}

function provenance(issue) {
  return `\n\n---\n\nRouted from ${issue.html_url}\nOriginal author: @${issue.user.login}`
    + `\n\n<!-- rookery:raven-source:${issue.node_id} -->`;
}

function copyBody(issue) {
  // Anchor leading whitespace before gh-aw's formatter trims the outer body.
  return `<!-- rookery:raven-original -->\n${issue.body ?? ''}${provenance(issue)}`;
}

async function currentSource(github, context) {
  const original = context.payload.issue;
  const { data: issue } = await github.rest.issues.get({
    ...repoParams(SOURCE), issue_number: original.number,
  });
  if (issue.node_id !== original.node_id || issue.pull_request
    || !ASSOCIATIONS.has(issue.author_association)) {
    throw new Error('Source identity or author eligibility changed');
  }
  if (issue.state !== 'open') return null;
  if (issue.title !== original.title || (issue.body ?? '') !== (original.body ?? '')
    || issue.user.id !== original.user.id) {
    throw new Error('Source changed since the opened event; manual routing is required');
  }
  return issue;
}

async function findCopies(github, source, actor) {
  const copies = [];
  for (const repository of DESTINATIONS) {
    const issues = await github.paginate(github.rest.issues.listForRepo, {
      ...repoParams(repository), state: 'all', since: source.created_at, per_page: 100,
    });
    for (const issue of issues) {
      if (!issue.pull_request && issue.user.id === actor.id
        && issue.body?.includes(provenance(source))) {
        copies.push({ repository, issue });
      }
    }
  }
  if (copies.length > 1) throw new Error('Multiple destination copies found; manual reconciliation is required');
  return copies[0];
}

async function confirmCopy(github, copy, source, actor) {
  const { data: issue } = await github.rest.issues.get({
    ...repoParams(copy.repository), issue_number: copy.issue.number,
  });
  if (issue.pull_request || issue.user.id !== actor.id
    || issue.title !== source.title
    || !issue.body?.includes(copyBody(source))
    || issue.html_url !== `https://github.com/${copy.repository}/issues/${issue.number}`) {
    throw new Error('Destination copy failed identity verification');
  }
  await addLabel(github, copy.repository, issue, LABELS.arrived);
  const { data: confirmed } = await github.rest.issues.get({
    ...repoParams(copy.repository), issue_number: issue.number,
  });
  if (!hasLabel(confirmed, LABELS.arrived.name)) throw new Error('Destination arrival label was not confirmed');
  return confirmed;
}

async function backlink(github, source, destination, actor) {
  const params = { ...repoParams(SOURCE), issue_number: source.number };
  const marker = `<!-- rookery:raven-link:${source.node_id} -->`;
  const body = `Routed to ${destination.html_url}.\n\n${marker}`;
  const comments = await github.paginate(github.rest.issues.listComments, { ...params, per_page: 100 });
  const existing = comments.filter((comment) => comment.user.id === actor.id && comment.body?.includes(marker));
  if (existing.some((comment) => comment.body !== body) || existing.length > 1) {
    throw new Error('Conflicting routing backlinks found; manual reconciliation is required');
  }
  if (existing.length === 0) {
    const { data: comment } = await github.rest.issues.createComment({ ...params, body });
    if (comment.body !== body || comment.user.id !== actor.id) {
      throw new Error('Source backlink was not confirmed');
    }
  }
}

async function routeRaven({ github, readGithub, context, output, createIssue, execution }) {
  if (!eligible(context)) return { status: 'skipped' };
  if (execution?.agent !== 'success'
    || !['success', 'skipped'].includes(execution.detection)
    || execution.detectionReason) {
    throw new Error('Agent execution or threat detection did not complete safely; no routing writes allowed');
  }
  let source = await currentSource(github, context);
  if (!source) return { status: 'skipped' };
  const decision = decisionFrom(output);
  const { documents, errors } = await publicDocumentation(readGithub);
  if (errors.length || documents.length !== PUBLIC_REPOS.length) {
    await addLabel(github, SOURCE, source, LABELS.blind);
    throw new Error(`Required public documentation unavailable: ${errors.join('; ')}`);
  }

  const { data: actor } = await github.rest.users.getAuthenticated();
  let copy = await findCopies(github, source, actor);
  if (!copy && hasLabel(source, LABELS.sent.name)) {
    throw new Error('Source is marked sent but no authenticated copy was found; manual reconciliation is required');
  }
  if (!copy && decision.destination === 'blind') {
    await addLabel(github, SOURCE, source, LABELS.blind);
    return { status: 'blind' };
  }
  if (!copy) {
    await ensureLabel(github, decision.destination, LABELS.arrived);
    const result = await createIssue({
      ...repoParams(decision.destination),
      title: source.title,
      body: copyBody(source),
      labels: [LABELS.arrived.name],
    });
    if (result.staged || !result.issue) throw new Error('Destination creation did not return a live issue');
    copy = { repository: decision.destination, issue: result.issue };
  }
  const destination = await confirmCopy(github, copy, source, actor);
  source = await currentSource(github, context);
  if (!source) throw new Error('Source closed during routing; leaving the existing copy for manual review');
  await backlink(github, source, destination, actor);
  await addLabel(github, SOURCE, source, LABELS.sent);
  if (hasLabel(source, LABELS.blind.name)) {
    await github.rest.issues.removeLabel({
      ...repoParams(SOURCE), issue_number: source.number, name: LABELS.blind.name,
    });
  }
  source = await currentSource(github, context);
  if (!source) throw new Error('Source closed during routing; no further changes made');
  if (!hasLabel(source, LABELS.sent.name)) throw new Error('Source sent label was not confirmed');
  const { data: closed } = await github.rest.issues.update({
    ...repoParams(SOURCE), issue_number: source.number, state: 'closed', state_reason: 'not_planned',
  });
  if (closed.state !== 'closed') throw new Error('Source close was not confirmed');
  return { status: 'sent', destination: destination.html_url };
}

module.exports = {
  SOURCE, DESTINATIONS, PUBLIC_REPOS, LABELS,
  eligible, publicDocumentation, prepareContext, decisionFrom, routeRaven,
};
