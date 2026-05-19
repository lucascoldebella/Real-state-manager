'use client';

import type { ClientAuthResponse, ClientUser } from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
const TOKEN_KEY = 'oc_client_token';
const USER_KEY = 'oc_client_user';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

function extractError(raw: string): string {
  if (!raw) return 'Unknown error';
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed?.error) return parsed.error;
  } catch { /* ignore */ }
  return raw;
}

export function getClientToken(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(TOKEN_KEY) || '';
}

export function getClientUser(): ClientUser | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as ClientUser; } catch { return null; }
}

export function setClientSession(token: string, user: ClientUser): void {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearClientSession(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
}

async function request<T>(path: string, method: HttpMethod, body?: unknown, authRequired = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (authRequired) {
    const token = getClientToken();
    if (!token) throw new Error('Not authenticated.');
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) clearClientSession();
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`${method} ${path} (${response.status}): ${extractError(raw)}`);
  }
  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

export async function clientLoginRequest(email: string, password: string): Promise<ClientAuthResponse> {
  return request<ClientAuthResponse>('/api/client/auth/login', 'POST', { email, password }, false);
}

export async function clientLogout(): Promise<void> {
  try { await request<{ message: string }>('/api/client/auth/logout', 'POST'); } catch { /* ignore */ }
  finally { clearClientSession(); }
}

export async function clientGet<T>(path: string): Promise<T> {
  return request<T>(path, 'GET');
}

export async function clientPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, 'POST', body);
}

export async function clientPut<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, 'PUT', body);
}

export async function clientFetchMe(): Promise<ClientUser> {
  return request<ClientUser>('/api/client/auth/me', 'GET');
}
