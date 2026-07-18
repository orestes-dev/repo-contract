// Minimal GitHub REST client using global fetch. Zero dependencies so the
// composite action can run without an `npm install` step on the runner.

// Bound every request so a hung connection can't stall the action. No retry: the
// next issue event re-runs the diff-based gate cleanly.
const REQUEST_TIMEOUT_MS = 10_000;

// GitHub's Search API caps total results at 1000 (10 pages of 100).
const SEARCH_PER_PAGE = 100;
const SEARCH_MAX_PAGES = 10;

/**
 * The subset of an issue resource the gate reads.
 * @typedef {object} Issue
 * @property {number} number
 * @property {string} title
 * @property {string} [body]
 * @property {Array<string|{name: string}>} [labels]
 */

/**
 * The subset of a comment resource the gate reads.
 * @typedef {object} Comment
 * @property {number} id
 * @property {string} body
 * @property {{type?: string}} [user]
 */

/**
 * A linked issue a PR closes on merge, from GitHub's native
 * `closingIssuesReferences`. `sameRepo` is resolved here (against the client's
 * own owner/repo) so downstream clearance logic stays free of repo context.
 * @typedef {object} LinkedIssue
 * @property {number} number
 * @property {string} owner - The linked issue's repository owner login.
 * @property {string} repo - The linked issue's repository name.
 * @property {boolean} sameRepo - Whether it lives in the PR's own repository.
 * @property {string[]} labels - The linked issue's label names.
 */

/**
 * Strip any trailing slashes from a URL so path concatenation stays clean.
 * @param {string} url
 * @returns {string}
 */
function stripTrailingSlashes(url) {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}

export class GitHub {
  /**
   * @param {object} config
   * @param {string} config.token - Bearer token for the REST API.
   * @param {string} [config.apiUrl] - API base URL; defaults to api.github.com.
   * @param {string} config.owner - Repository owner.
   * @param {string} config.repo - Repository name.
   */
  constructor({ token, apiUrl, owner, repo }) {
    this.token = token;
    this.apiUrl = stripTrailingSlashes(apiUrl || "https://api.github.com");
    this.owner = owner;
    this.repo = repo;
  }

  /**
   * Common request headers for both the REST and GraphQL endpoints.
   * @returns {Record<string, string>}
   */
  #headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "repo-contract",
    };
  }

  /**
   * Issue a timeout-bounded REST request.
   * @param {string} method - HTTP method.
   * @param {string} path - API path, appended to the base URL.
   * @param {object} [body] - JSON payload; omitted for bodyless methods.
   * @returns {Promise<Response>}
   */
  async #request(method, path, body) {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: this.#headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res;
  }

  /**
   * Issue a timeout-bounded GraphQL request, returning the `data` payload. Used
   * for `closingIssuesReferences`, which the REST API does not expose. Throws on
   * a transport error or any GraphQL `errors` entry (fail loud).
   * @param {string} query - The GraphQL query document.
   * @param {Record<string, unknown>} variables - Query variables.
   * @returns {Promise<any>} The `data` object.
   */
  async #graphql(query, variables) {
    const res = await fetch(`${this.apiUrl}/graphql`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GraphQL request failed: ${res.status}`);
    const json = /** @type {{data?: any, errors?: unknown}} */ (
      await res.json()
    );
    if (json.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
    }
    return json.data;
  }

  /**
   * Repo-scoped API path prefix.
   * @returns {string}
   */
  #base() {
    return `/repos/${this.owner}/${this.repo}`;
  }

  /**
   * Fetch fresh; the webhook payload can't be trusted.
   * @param {number} issueNumber
   * @returns {Promise<Issue>} The issue resource.
   */
  async getIssue(issueNumber) {
    const res = await this.#request(
      "GET",
      `${this.#base()}/issues/${issueNumber}`,
    );
    if (!res.ok) throw new Error(`Failed to fetch issue: ${res.status}`);
    return /** @type {Promise<Issue>} */ (res.json());
  }

  /**
   * Fetch a pull request fresh from the API (title/body/labels are mutable, so
   * the event payload can be stale). The `pulls` endpoint carries `user.login`;
   * it is flattened to `author` so the gate's bot exemption can key off it. The
   * head branch name (`headRef`) and the base repo's default branch
   * (`defaultBranch`) ride along so the commit gate can flag a PR opened from the
   * default branch without a second request. Label and comment writes still go
   * through the shared issues endpoints, since every PR is also an issue with the
   * same number.
   * @param {number} prNumber
   * @returns {Promise<Issue & {author: string, headRef: string, defaultBranch: string}>} The PR resource.
   */
  async getPullRequest(prNumber) {
    const res = await this.#request("GET", `${this.#base()}/pulls/${prNumber}`);
    if (!res.ok) throw new Error(`Failed to fetch pull request: ${res.status}`);
    const pr =
      /** @type {Issue & {user?: {login?: string}, head?: {ref?: string}, base?: {repo?: {default_branch?: string}}}} */ (
        await res.json()
      );
    return {
      ...pr,
      author: pr.user?.login ?? "",
      headRef: pr.head?.ref ?? "",
      defaultBranch: pr.base?.repo?.default_branch ?? "",
    };
  }

  /**
   * Paginate a repo-scoped list endpoint to exhaustion, collecting every item.
   * Bounds each page at 100 (the REST maximum) and stops on the first short
   * page. Used for a PR's commits and files, both of which can span pages.
   * @param {string} path - Repo-relative path (after `#base()`), no query string.
   * @param {string} what - Noun for the error message, e.g. "pull request commits".
   * @returns {Promise<any[]>}
   */
  async #paginate(path, what) {
    /** @type {any[]} */
    const items = [];
    let page = 1;
    for (;;) {
      const res = await this.#request(
        "GET",
        `${this.#base()}${path}?per_page=100&page=${page}`,
      );
      if (!res.ok) throw new Error(`Failed to fetch ${what}: ${res.status}`);
      const batch = /** @type {any[]} */ (await res.json());
      items.push(...batch);
      if (batch.length < 100) return items;
      page += 1;
    }
  }

  /**
   * The commits on a pull request, each flattened to `{ sha, subject }` (the
   * subject is the first line of the commit message). The commit gate checks each
   * subject against Conventional Commits.
   * @param {number} prNumber
   * @returns {Promise<{sha: string, subject: string}[]>}
   */
  async getPullRequestCommits(prNumber) {
    const commits = await this.#paginate(
      `/pulls/${prNumber}/commits`,
      "pull request commits",
    );
    return commits.map((c) => ({
      sha: c.sha,
      subject: String(c.commit?.message ?? "").split("\n")[0],
    }));
  }

  /**
   * The files changed by a pull request, each flattened to `{ filename, patch }`.
   * The `patch` is the unified diff hunk (absent for binary or truncated files).
   * The commit gate scans added lines for em dashes.
   * @param {number} prNumber
   * @returns {Promise<{filename: string, patch: string}[]>}
   */
  async getPullRequestFiles(prNumber) {
    const files = await this.#paginate(
      `/pulls/${prNumber}/files`,
      "pull request files",
    );
    return files.map((f) => ({
      filename: f.filename,
      patch: f.patch ?? "",
    }));
  }

  /**
   * The issues a PR closes on merge, from GitHub's native
   * `closingIssuesReferences` (populated by `Closes #N` or the Development
   * sidebar), not a parsed body field. Each node's repository resolves
   * `sameRepo` against this client's owner/repo, and its labels ride along so a
   * caller can judge clearance without a second round trip.
   * @param {number} prNumber
   * @returns {Promise<LinkedIssue[]>}
   */
  async getLinkedIssues(prNumber) {
    const query = `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          closingIssuesReferences(first: 50) {
            nodes {
              number
              repository { owner { login } name }
              labels(first: 50) { nodes { name } }
            }
          }
        }
      }
    }`;
    const data = await this.#graphql(query, {
      owner: this.owner,
      repo: this.repo,
      number: prNumber,
    });
    /** @type {Array<{number: number, repository: {owner: {login: string}, name: string}, labels: {nodes: Array<{name: string}>}}>} */
    const nodes =
      data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [];
    return nodes.map((node) => {
      const owner = node.repository.owner.login;
      const repo = node.repository.name;
      return {
        number: node.number,
        owner,
        repo,
        sameRepo: owner === this.owner && repo === this.repo,
        labels: (node.labels?.nodes ?? []).map((l) => l.name),
      };
    });
  }

  /**
   * Create the label with its color/description if it doesn't exist.
   * @param {string} name
   * @param {string} color - Six-digit hex, no leading `#`.
   * @param {string} description
   * @returns {Promise<void>}
   */
  async ensureLabel(name, color, description) {
    const res = await this.#request(
      "GET",
      `${this.#base()}/labels/${encodeURIComponent(name)}`,
    );
    if (res.ok) return;
    if (res.status !== 404) {
      throw new Error(`Failed to look up label ${name}: ${res.status}`);
    }
    const create = await this.#request("POST", `${this.#base()}/labels`, {
      name,
      color,
      description,
    });
    // 422 = created concurrently by a racing run; treat as success.
    if (!create.ok && create.status !== 422) {
      throw new Error(`Failed to create label ${name}: ${create.status}`);
    }
  }

  /**
   * Add labels to an issue. No-op on an empty list.
   * @param {number} issueNumber
   * @param {string[]} labels
   * @returns {Promise<void>}
   */
  async addLabels(issueNumber, labels) {
    if (labels.length === 0) return;
    const res = await this.#request(
      "POST",
      `${this.#base()}/issues/${issueNumber}/labels`,
      { labels },
    );
    if (!res.ok) throw new Error(`Failed to add labels: ${res.status}`);
  }

  /**
   * Remove one label from an issue. A 404 (label absent) is not an error.
   * @param {number} issueNumber
   * @param {string} label
   * @returns {Promise<void>}
   */
  async removeLabel(issueNumber, label) {
    const res = await this.#request(
      "DELETE",
      `${this.#base()}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    );
    // 404 = label wasn't present; not an error for our purposes.
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to remove label ${label}: ${res.status}`);
    }
  }

  /**
   * First comment matching `predicate`, paging lazily. The gate comment is
   * created early, so it's usually on the first page.
   * @param {number} issueNumber
   * @param {(comment: Comment) => boolean} predicate
   * @returns {Promise<Comment|null>} The matching comment, or null if none.
   */
  async findComment(issueNumber, predicate) {
    let page = 1;
    for (;;) {
      const res = await this.#request(
        "GET",
        `${this.#base()}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      );
      if (!res.ok) throw new Error(`Failed to list comments: ${res.status}`);
      const batch = /** @type {Comment[]} */ (await res.json());
      const hit = batch.find(predicate);
      if (hit) return hit;
      if (batch.length < 100) return null;
      page += 1;
    }
  }

  /**
   * Search issues matching `qualifiers`, paging to the 1000-result cap.
   * `totalCount` can exceed `items.length` when capped, letting the caller
   * detect a partial sweep. `is:issue` excludes PRs.
   * @param {string} qualifiers - Raw search qualifiers, e.g. `is:issue is:open`.
   * @returns {Promise<{totalCount: number, items: Issue[]}>}
   */
  async searchIssues(qualifiers) {
    const q = `repo:${this.owner}/${this.repo} ${qualifiers}`;
    /** @type {Issue[]} */
    const items = [];
    let totalCount = 0;
    for (let page = 1; page <= SEARCH_MAX_PAGES; page += 1) {
      const res = await this.#request(
        "GET",
        `/search/issues?q=${encodeURIComponent(q)}&per_page=${SEARCH_PER_PAGE}&page=${page}`,
      );
      if (!res.ok) throw new Error(`Failed to search issues: ${res.status}`);
      const body = /** @type {{total_count: number, items: Issue[]}} */ (
        await res.json()
      );
      totalCount = body.total_count;
      items.push(...body.items);
      if (body.items.length < SEARCH_PER_PAGE) break;
    }
    return { totalCount, items };
  }

  /**
   * @param {number} issueNumber
   * @param {string} bodyText - Comment markdown.
   * @returns {Promise<void>}
   */
  async createComment(issueNumber, bodyText) {
    const res = await this.#request(
      "POST",
      `${this.#base()}/issues/${issueNumber}/comments`,
      { body: bodyText },
    );
    if (!res.ok) throw new Error(`Failed to create comment: ${res.status}`);
  }

  /**
   * @param {number} commentId
   * @param {string} bodyText - Replacement comment markdown.
   * @returns {Promise<void>}
   */
  async updateComment(commentId, bodyText) {
    const res = await this.#request(
      "PATCH",
      `${this.#base()}/issues/comments/${commentId}`,
      { body: bodyText },
    );
    if (!res.ok) throw new Error(`Failed to update comment: ${res.status}`);
  }

  /**
   * Delete a comment. A 404 (already gone) is not an error.
   * @param {number} commentId
   * @returns {Promise<void>}
   */
  async deleteComment(commentId) {
    const res = await this.#request(
      "DELETE",
      `${this.#base()}/issues/comments/${commentId}`,
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete comment: ${res.status}`);
    }
  }
}
