import { existsSync, readFileSync, statSync } from "fs";
import { homedir, userInfo } from "os";
import { dirname, join } from "path";

export type GitHubTokenSource = "env" | "pi-git-credentials" | "git-credentials" | "gh-cli";

export interface GitHubToken {
  token: string;
  source: GitHubTokenSource;
}

const TOKEN_TTL_MS = 60_000;

declare global {
  var __piPrTokenCache: { value: GitHubToken | null; expiresAt: number } | undefined;
}

/**
 * `https://user:token@github.com` lines written by `git config credential.helper store`.
 * Only github.com entries count: a token for another host would fail every call.
 */
export function tokenFromCredentialStore(contents: string, host = "github.com"): string | null {
  for (const line of contents.split(/\r?\n/)) {
    const match = /^https?:\/\/([^:@/]+):([^@/]+)@([^/]+)\/?$/.exec(line.trim());
    if (!match) continue;
    if (match[3].toLowerCase() !== host) continue;
    const secret = decodeURIComponent(match[2]);
    // A token never contains whitespace; a stray space means a hand-edited line.
    if (secret && !/\s/.test(secret)) return secret;
  }
  return null;
}

/** `gh auth login` stores `oauth_token:` under hosts.yml. */
export function tokenFromGhHosts(contents: string, host = "github.com"): string | null {
  let inHost = false;
  for (const line of contents.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inHost = line.trim().replace(/:$/, "") === host;
      continue;
    }
    if (!inHost) continue;
    const match = /^\s+oauth_token:\s*(\S+)\s*$/.exec(line);
    if (match) return match[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

function readIfFile(path: string): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * First usable GitHub credential. Environment wins so a caller can override,
 * then the credential store pi's git setup already uses.
 */
export function resolveGitHubToken(): GitHubToken | null {
  const cached = globalThis.__piPrTokenCache;
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = findGitHubToken();
  globalThis.__piPrTokenCache = { value, expiresAt: Date.now() + TOKEN_TTL_MS };
  return value;
}

/**
 * Every directory that can hold the user's credentials. `HOME` is often not the
 * account's home inside containers (the agent dir is), so all candidates count.
 */
export function candidateHomeDirs(): string[] {
  const dirs = new Set<string>();
  // The agent dir is <home>/.pi/agent, so the home is two levels up; add both
  // in case an operator points PI_CODING_AGENT_DIR somewhere shallower.
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) {
    dirs.add(dirname(agentDir));
    dirs.add(dirname(dirname(agentDir)));
  }
  for (const candidate of [process.env.HOME?.trim(), safeHomedir(), safeUserHomedir()]) {
    if (candidate) dirs.add(candidate);
  }
  return [...dirs];
}

function safeHomedir(): string | null {
  try {
    return homedir() || null;
  } catch {
    return null;
  }
}

function safeUserHomedir(): string | null {
  try {
    return userInfo().homedir || null;
  } catch {
    return null;
  }
}

function findGitHubToken(): GitHubToken | null {
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "PI_WEB_GITHUB_TOKEN"]) {
    const fromEnv = process.env[name]?.trim();
    if (fromEnv) return { token: fromEnv, source: "env" };
  }

  const homes = candidateHomeDirs();
  for (const home of homes) {
    for (const [file, source] of [
      [".pi-git-credentials", "pi-git-credentials"],
      [".git-credentials", "git-credentials"],
    ] as const) {
      const contents = readIfFile(join(home, file));
      const token = contents ? tokenFromCredentialStore(contents) : null;
      if (token) return { token, source };
    }
  }

  for (const home of homes) {
    const hosts = readIfFile(join(home, ".config", "gh", "hosts.yml"));
    const ghToken = hosts ? tokenFromGhHosts(hosts) : null;
    if (ghToken) return { token: ghToken, source: "gh-cli" };
  }

  return null;
}

/** Test seam: drop the memoized credential after settings or stores change. */
export function invalidateGitHubTokenCache(): void {
  globalThis.__piPrTokenCache = undefined;
}
