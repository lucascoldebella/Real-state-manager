'use client';

import type { AuthResponse, AuthUser } from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8090';
const TOKEN_KEY = 'oc_dashboard_token';
const USER_KEY = 'oc_dashboard_user';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

function ensureBrowser(): void {
  if (typeof window === 'undefined') {
    throw new Error('This action requires browser context.');
  }
}

function extractError(raw: string): string {
  if (!raw) return 'Unknown error';
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed?.error) return parsed.error;
  } catch {
    // ignore parse error
  }
  return raw;
}

export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

export function getStoredToken(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(TOKEN_KEY) || '';
}

export function getStoredUser(): AuthUser | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function setStoredSession(token: string, user: AuthUser): void {
  ensureBrowser();
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearStoredSession(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
}

async function request<T>(path: string, method: HttpMethod, body?: unknown, authRequired = true): Promise<T> {
  const headers: Record<string, string> = {};

  if (authRequired) {
    const token = getStoredToken();
    if (!token) {
      throw new Error('Not authenticated.');
    }
    headers.Authorization = `Bearer ${token}`;
  }

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401) {
    clearStoredSession();
  }

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`Request failed ${method} ${path} (${response.status}): ${extractError(raw)}`);
  }

  if (response.status === 204) {
    return null as T;
  }

  return (await response.json()) as T;
}

export async function loginRequest(email: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/login', 'POST', { email, password }, false);
}

export async function fetchMe(): Promise<{ user: AuthUser }> {
  return request<{ user: AuthUser }>('/api/auth/me', 'GET');
}

export async function logoutRequest(): Promise<void> {
  try {
    await request<{ message: string }>('/api/auth/logout', 'POST');
  } catch {
    // ignore logout failures and clear local session anyway
  } finally {
    clearStoredSession();
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, 'GET');
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, 'POST', body);
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, 'PUT', body);
}

export async function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, 'DELETE');
}

export async function apiPublicPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, 'POST', body, false);
}

export async function downloadWithAuth(path: string, fileName: string): Promise<void> {
  const token = getStoredToken();
  if (!token) {
    throw new Error('Not authenticated.');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`Download failed (${response.status}): ${extractError(raw)}`);
  }

  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}
