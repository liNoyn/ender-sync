// Derived from rometet/inventory-sync (https://github.com/rometet/inventory-sync) by rometet.
// Adapted for Ender Sync; see the Credits section of the root README.

import {
  HttpHeader,
  HttpRequest,
  HttpRequestMethod,
  type HttpResponse,
  http,
} from "@minecraft/server-net";
import {
  type ApiOkResponse,
  type EnderAuditRequest,
  type EnderLoadResponse,
  type EnderSaveResponse,
  type EnderSnapshot,
  type EnderStatusResponse,
  type IdentityType,
  isApiOkResponse,
  isEnderLoadResponse,
  isEnderSaveResponse,
  isEnderStatusResponse,
} from "../domain/types";
import { config } from "../util/config";

type ApiErrorKind =
  | "timeout"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "server_error"
  | "invalid_json"
  | "network"
  | "unexpected_status";

export class ApiClientError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiClientError";
  }

  get playerMessage(): string {
    switch (this.kind) {
      case "timeout":
        return "APIリクエストがタイムアウトしました。";
      case "unauthorized":
        return "API認証に失敗しました。";
      case "not_found":
        return "保存済みのエンダーチェストが見つかりません。";
      case "conflict":
        return "未適用の保存データがあるため、保存を中止しました。先に /endersync:load で復元してください。";
      case "rate_limited":
        return "APIのレート制限に達しました。少し待ってから再試行してください。";
      case "server_error":
        return "API側でサーバーエラーが発生しました。";
      case "invalid_json":
        return "API応答の形式が不正です。";
      case "network":
      case "unexpected_status":
      default:
        return "APIリクエストに失敗しました。";
    }
  }
}

function buildUrl(path: string, query?: Record<string, string>): string {
  const base = config.apiBaseUrl.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  if (!query) {
    return `${base}${trimmedPath}`;
  }

  const queryString = Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `${base}${trimmedPath}?${queryString}`;
}

function createRequest(
  method: HttpRequestMethod,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): HttpRequest {
  const request = new HttpRequest(buildUrl(path, query));
  request.method = method;
  request.timeout = Math.max(1, Math.ceil(config.requestTimeoutMs / 1000));
  request.headers = [
    new HttpHeader("Content-Type", "application/json"),
    new HttpHeader("Authorization", `Bearer ${config.apiToken}`),
  ];

  if (body !== undefined) {
    request.body = JSON.stringify(body);
  }

  return request;
}

function mapStatusError(response: HttpResponse): ApiClientError {
  switch (response.status) {
    case 401:
    case 403:
      return new ApiClientError("unauthorized", "EnderSync API rejected the bearer token.", response.status);
    case 404:
      return new ApiClientError("not_found", "EnderSync API route or resource was not found.", response.status);
    case 409:
      return new ApiClientError("conflict", "EnderSync API refused to overwrite an unconsumed snapshot.", response.status);
    case 429:
      return new ApiClientError("rate_limited", "EnderSync API rate limit was reached.", response.status);
    default:
      return response.status >= 500
        ? new ApiClientError("server_error", "EnderSync API returned a server error.", response.status)
        : new ApiClientError("unexpected_status", "EnderSync API returned an unexpected HTTP status.", response.status);
  }
}

async function sendRequest<T>(request: HttpRequest, validator: (value: unknown) => value is T): Promise<T> {
  let response: HttpResponse;

  try {
    response = await http.request(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiClientError(/timed out/i.test(message) ? "timeout" : "network", message);
  }

  if (response.status < 200 || response.status >= 300) {
    throw mapStatusError(response);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new ApiClientError("invalid_json", "EnderSync API response body was not valid JSON.", response.status);
  }

  if (!validator(payload)) {
    throw new ApiClientError("invalid_json", "EnderSync API response body shape was invalid.", response.status);
  }

  return payload;
}

export function saveSnapshot(snapshot: EnderSnapshot): Promise<EnderSaveResponse> {
  return sendRequest(createRequest(HttpRequestMethod.Post, "/api/ender/save", snapshot), isEnderSaveResponse);
}

export function loadSnapshot(identityType: IdentityType, playerKey: string): Promise<EnderLoadResponse> {
  return sendRequest(
    createRequest(HttpRequestMethod.Get, "/api/ender/load", undefined, { identityType, playerKey }),
    isEnderLoadResponse,
  );
}

export function fetchSnapshotStatus(identityType: IdentityType, playerKey: string): Promise<EnderStatusResponse> {
  return sendRequest(
    createRequest(HttpRequestMethod.Get, "/api/ender/status", undefined, { identityType, playerKey }),
    isEnderStatusResponse,
  );
}

export function recordLoadApplied(snapshot: EnderSnapshot): Promise<ApiOkResponse> {
  const body: EnderAuditRequest = {
    identityType: snapshot.identityType,
    playerKey: snapshot.playerKey,
    snapshotId: snapshot.snapshotId,
    snapshotSavedAt: snapshot.savedAt,
    source: snapshot.source,
    executedSource: {
      serverId: config.serverId,
      worldId: config.worldId,
      worldName: config.worldName,
    },
    occurredAt: new Date().toISOString(),
  };
  return sendRequest(createRequest(HttpRequestMethod.Post, "/api/ender/audit/load", body), isApiOkResponse);
}
