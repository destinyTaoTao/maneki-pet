import type { IncomingMessage, ServerResponse } from "node:http";
import { AssistantError } from "./assistant-settings.js";
import type { AssistantService } from "./assistant-service.js";

export async function handleAssistantHttp(
  req: IncomingMessage,
  res: ServerResponse,
  client: { clientId: string; scopes: string[] },
  service: AssistantService,
  readBody: () => Promise<Record<string, unknown> | undefined>,
): Promise<void> {
  const send = (status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  try {
    if (
      !client.scopes.includes("assistant") &&
      !client.scopes.includes("admin")
    )
      throw new AssistantError(403, "assistant_scope_required");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.slice("/v1/assistant".length);
    if (req.method === "GET" && path === "/snapshot") {
      send(200, service.snapshot());
      return;
    }
    if (req.method === "GET" && path === "/history") {
      const before = Number(
        url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER,
      );
      if (!Number.isSafeInteger(before) || before < 1)
        throw new AssistantError(400, "cursor_invalid");
      send(200, service.history(before));
      return;
    }
    if (req.method === "GET" && path === "/settings") {
      send(200, service.settings());
      return;
    }
    if (
      req.method === "PUT" &&
      path === "/settings" &&
      !client.scopes.includes("settings") &&
      !client.scopes.includes("admin")
    )
      throw new AssistantError(403, "settings_scope_required");
    const request = /^\/chat\/([A-Za-z0-9_-]{1,80})(\/cancel)?$/.exec(path);
    if (req.method === "GET" && request && !request[2]) {
      send(200, service.request(client.clientId, request[1]!));
      return;
    }
    if (req.method !== "POST" && req.method !== "PUT") {
      send(404, { error: "not_found" });
      return;
    }
    const body = await readBody();
    if (!body) return;
    if (req.method === "POST" && path === "/chat") {
      send(202, service.submit(client.clientId, body));
      return;
    }
    if (req.method === "POST" && path === "/mutations") {
      send(200, service.mutation(client.clientId, body));
      return;
    }
    if (req.method === "POST" && path === "/clear-preview") {
      if (Object.keys(body).some((k) => k !== "scope"))
        throw new AssistantError(400, "request_invalid");
      send(200, service.preview(client.clientId, body.scope));
      return;
    }
    if (req.method === "POST" && path === "/clear") {
      if (Object.keys(body).some((k) => k !== "confirmationId"))
        throw new AssistantError(400, "request_invalid");
      send(200, service.clear(client.clientId, body.confirmationId));
      return;
    }
    if (req.method === "POST" && request?.[2]) {
      if (Object.keys(body).length)
        throw new AssistantError(400, "request_invalid");
      send(200, service.cancel(client.clientId, request[1]!));
      return;
    }
    if (req.method === "PUT" && path === "/settings") {
      send(200, service.updateSettings(body));
      return;
    }
    send(404, { error: "not_found" });
  } catch (error) {
    send(error instanceof AssistantError ? error.status : 500, {
      error: error instanceof AssistantError ? error.code : "assistant_failed",
    });
  }
}
