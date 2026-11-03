/**
 * The few GitHub API calls the implementer makes, with Node's own fetch. No
 * client library, for the reason package.json gives.
 */

const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const graphqlUrl = process.env.GITHUB_GRAPHQL_URL ?? 'https://api.github.com/graphql';

export function client(token, repository) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };

  async function api(path, { method = 'GET', body, allow = [] } = {}) {
    const url = path.startsWith('http') ? path : `${apiUrl}${path.replace('{repo}', repository)}`;
    const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok && !allow.includes(response.status)) {
      throw new Error(`${method} ${url}: ${response.status} ${await response.text()}`);
    }
    if (response.status === 204) return { status: response.status, json: null };
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }

  /** Every page of a list endpoint. */
  async function all(path) {
    const items = [];
    for (let page = 1; ; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const { json } = await api(`${path}${separator}per_page=100&page=${page}`);
      items.push(...json);
      if (json.length < 100) return items;
    }
  }

  async function graphql(query, variables) {
    const response = await fetch(graphqlUrl, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
    const json = await response.json();
    if (!response.ok || json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors ?? json)}`);
    return json.data;
  }

  /** Review threads with their comments. 100 threads of 50 comments is plenty for one agent's pull request. */
  async function reviewThreads(number) {
    const [owner, name] = repository.split('/');
    const data = await graphql(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                isResolved isOutdated path line originalLine
                comments(first: 50) {
                  nodes { body createdAt url authorAssociation author { __typename login } }
                }
              }
            }
          }
        }
      }`,
      { owner, name, number: Number(number) },
    );
    return data.repository.pullRequest.reviewThreads.nodes.map(thread => ({
      ...thread,
      comments: thread.comments.nodes,
    }));
  }

  return { api, all, reviewThreads };
}
