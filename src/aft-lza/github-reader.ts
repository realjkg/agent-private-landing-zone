/**
 * Read-only GitHub reads for the AFT/LZA pilot: the head commit of the LZA configuration and AFT request branches. Uses the
 * GitHub REST API with a token the caller supplies (in GitHub Actions, the job's GITHUB_TOKEN or a read-only GitHub App token
 * for the customer repositories). GET only. The token is never written to a report or a log.
 */
export type Fetcher = (url: string, init: { method: "GET"; headers: Record<string, string> }) => Promise<{ status: number; json: () => Promise<unknown> }>;

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

export class GitHubReader {
  constructor(private readonly token: string | undefined, private readonly fetcher: Fetcher = fetch as unknown as Fetcher, private readonly api = "https://api.github.com") {}

  /** The full SHA at the branch head, or undefined when it cannot be read (no token, not found, no access). */
  async branchHead(repository: string, branch: string): Promise<string | undefined> {
    if (!REPO.test(repository) || !BRANCH.test(branch) || branch.includes("..")) throw new Error("INVALID_REPOSITORY_OR_BRANCH");
    if (!this.token) return undefined;
    const response = await this.fetcher(this.api + "/repos/" + repository + "/commits/" + encodeURIComponent(branch), {
      method: "GET", headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + this.token, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (response.status !== 200) return undefined;
    const sha = (await response.json() as Record<string, unknown>).sha;
    return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  }
}
