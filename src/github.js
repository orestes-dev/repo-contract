// Minimal GitHub REST client using global fetch. Zero dependencies so the
// composite action can run without an `npm install` step on the runner.

// Bound every request so a hung connection can't stall the action. No retry: the
// next issue event re-runs the diff-based gate cleanly.
const REQUEST_TIMEOUT_MS = 10_000;

// GitHub's Search API caps total results at 1000 (10 pages of 100).
const SEARCH_PER_PAGE = 100;
const SEARCH_MAX_PAGES = 10;

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
   * Issue a timeout-bounded REST request.
   * @param {string} method - HTTP method.
   * @param {string} path - API path, appended to the base URL.
   * @param {object} [body] - JSON payload; omitted for bodyless methods.
   * @returns {Promise<Response>}
   */
  async #request(method, path, body) {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "issue-quality-gate",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res;
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
   * @returns {Promise<object>} The issue resource.
   */
  async getIssue(issueNumber) {
    const res = await this.#request(
      "GET",
      `${this.#base()}/issues/${issueNumber}`,
    );
    if (!res.ok) throw new Error(`Failed to fetch issue: ${res.status}`);
    return res.json();
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
   * @param {(comment: object) => boolean} predicate
   * @returns {Promise<object|null>} The matching comment, or null if none.
   */
  async findComment(issueNumber, predicate) {
    let page = 1;
    for (;;) {
      const res = await this.#request(
        "GET",
        `${this.#base()}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      );
      if (!res.ok) throw new Error(`Failed to list comments: ${res.status}`);
      const batch = await res.json();
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
   * @returns {Promise<{totalCount: number, items: object[]}>}
   */
  async searchIssues(qualifiers) {
    const q = `repo:${this.owner}/${this.repo} ${qualifiers}`;
    const items = [];
    let totalCount = 0;
    for (let page = 1; page <= SEARCH_MAX_PAGES; page += 1) {
      const res = await this.#request(
        "GET",
        `/search/issues?q=${encodeURIComponent(q)}&per_page=${SEARCH_PER_PAGE}&page=${page}`,
      );
      if (!res.ok) throw new Error(`Failed to search issues: ${res.status}`);
      const body = await res.json();
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
