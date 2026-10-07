import {
  createServer,
  type Server,
} from "node:http";

import {
  assertProductionDeploymentContract,
} from "../qualification/production-contract.js";

export type ReadinessCheck = {
  name: string;
  ready: boolean;
  detail: string;
};

export type ReadinessSnapshot = {
  ready: boolean;
  checks: ReadinessCheck[];
  actEnabled: false;
};

export type HealthSnapshot = {
  healthy: true;
  service:
    "agent-private-landing-zone";
  operatingMode:
    "PREVIEW_OPERATE";
  actEnabled: false;
};

export function healthSnapshot():
  HealthSnapshot {
  return {
    healthy: true,
    service:
      "agent-private-landing-zone",
    operatingMode:
      "PREVIEW_OPERATE",
    actEnabled: false,
  };
}

export function readinessSnapshot(
  checks: ReadinessCheck[],
): ReadinessSnapshot {
  assertProductionDeploymentContract();

  return {
    ready:
      checks.length > 0 &&
      checks.every(
        (check) =>
          check.ready,
      ),
    checks: [...checks],
    actEnabled: false,
  };
}

function loopback(
  host: string,
): boolean {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1"
  );
}

export type HealthServer = {
  server: Server;
  address: string;
  close: () => Promise<void>;
};

export async function startHealthServer(input: {
  readiness:
    () =>
      | ReadinessSnapshot
      | Promise<
          ReadinessSnapshot
        >;
  host?: string;
  port?: number;
}): Promise<HealthServer> {
  const host =
    input.host ??
    "127.0.0.1";

  if (!loopback(host)) {
    throw new Error(
      "HEALTH_ENDPOINT_BIND_DENIED: production health endpoints are loopback-only.",
    );
  }

  const server =
    createServer(
      async (
        request,
        response,
      ) => {
        response.setHeader(
          "content-type",
          "application/json",
        );
        response.setHeader(
          "cache-control",
          "no-store",
        );

        if (
          request.method !==
          "GET"
        ) {
          response.statusCode =
            405;
          response.end(
            JSON.stringify({
              error:
                "method-not-allowed",
            }),
          );
          return;
        }

        if (
          request.url ===
          "/healthz"
        ) {
          response.statusCode =
            200;
          response.end(
            JSON.stringify(
              healthSnapshot(),
            ),
          );
          return;
        }

        if (
          request.url ===
          "/readyz"
        ) {
          const snapshot =
            await input.readiness();

          response.statusCode =
            snapshot.ready
              ? 200
              : 503;
          response.end(
            JSON.stringify(
              snapshot,
            ),
          );
          return;
        }

        response.statusCode =
          404;
        response.end(
          JSON.stringify({
            error: "not-found",
          }),
        );
      },
    );

  await new Promise<void>(
    (resolve, reject) => {
      server.once(
        "error",
        reject,
      );
      server.listen(
        input.port ?? 0,
        host,
        () => {
          server.off(
            "error",
            reject,
          );
          resolve();
        },
      );
    },
  );

  const address =
    server.address();

  if (
    !address ||
    typeof address ===
      "string"
  ) {
    server.close();
    throw new Error(
      "HEALTH_ENDPOINT_ADDRESS_UNAVAILABLE",
    );
  }

  return {
    server,
    address:
      "http://" +
      host +
      ":" +
      address.port,
    close: () =>
      new Promise<void>(
        (resolve, reject) => {
          server.close(
            (error) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            },
          );
        },
      ),
  };
}
