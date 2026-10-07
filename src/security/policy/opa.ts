import type {
  SecurityPolicyDecision,
  SecurityPolicyEvaluator,
  SecurityPolicyInput,
} from "./types.js";

export type OpaPolicyOptions = {
  baseUrl?: string;
  decisionPath?: string;
  fetchImpl?: typeof fetch;
};

type OpaResponse = {
  result?: {
    allow?: boolean;
    reasons?: string[];
    obligations?: string[];
  };
  decision_id?: string;
};

function normalizeLoopbackUrl(
  value: string,
): string {
  const url = new URL(value);

  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:"
  ) {
    throw new Error(
      "OPA_ENDPOINT_DENIED: only HTTP(S) loopback endpoints are allowed.",
    );
  }

  const host =
    url.hostname.toLowerCase();

  if (
    host !== "localhost" &&
    host !== "127.0.0.1" &&
    host !== "::1" &&
    host !== "[::1]"
  ) {
    throw new Error(
      "OPA_ENDPOINT_DENIED: OPA must be local to the sovereign runtime.",
    );
  }

  return url
    .toString()
    .replace(/\/$/, "");
}

function normalizeDecisionPath(
  value: string,
): string {
  const path =
    value
      .trim()
      .replace(/^\/+/, "")
      .replace(/\.+/g, ".");

  if (
    !/^[a-zA-Z0-9_/-]+$/.test(
      path,
    )
  ) {
    throw new Error(
      "OPA_DECISION_PATH_INVALID",
    );
  }

  return path.replace(
    /\//g,
    "/",
  );
}

export class OpaSecurityPolicyEvaluator
  implements SecurityPolicyEvaluator
{
  private readonly baseUrl: string;
  private readonly decisionPath: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    options: OpaPolicyOptions = {},
  ) {
    this.baseUrl =
      normalizeLoopbackUrl(
        options.baseUrl ??
          "http://127.0.0.1:8181",
      );

    this.decisionPath =
      normalizeDecisionPath(
        options.decisionPath ??
          "agent_landing_zone/security/decision",
      );

    this.fetchImpl =
      options.fetchImpl ?? fetch;
  }

  async evaluate(
    input: SecurityPolicyInput,
  ): Promise<SecurityPolicyDecision> {
    let response: Response;

    try {
      response =
        await this.fetchImpl(
          this.baseUrl +
            "/v1/data/" +
            this.decisionPath,
          {
            method: "POST",
            headers: {
              "content-type":
                "application/json",
            },
            body: JSON.stringify({
              input,
            }),
          },
        );
    } catch {
      return {
        allow: false,
        reasons: [
          "OPA decision point is unavailable.",
        ],
        obligations: [],
        source: "OPA",
      };
    }

    if (!response.ok) {
      return {
        allow: false,
        reasons: [
          "OPA decision point returned HTTP " +
            response.status +
            ".",
        ],
        obligations: [],
        source: "OPA",
      };
    }

    let payload: OpaResponse;

    try {
      payload =
        (await response.json()) as OpaResponse;
    } catch {
      return {
        allow: false,
        reasons: [
          "OPA decision response was not valid JSON.",
        ],
        obligations: [],
        source: "OPA",
      };
    }

    if (
      typeof payload.result
        ?.allow !== "boolean"
    ) {
      return {
        allow: false,
        reasons: [
          "OPA decision was undefined or did not contain a boolean allow result.",
        ],
        obligations: [],
        source: "OPA",
        decisionId:
          payload.decision_id,
      };
    }

    return {
      allow:
        payload.result.allow,
      reasons:
        payload.result.reasons ??
        [],
      obligations:
        payload.result.obligations ??
        [],
      source: "OPA",
      decisionId:
        payload.decision_id,
    };
  }
}
