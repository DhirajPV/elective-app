const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export interface Creator {
  id: string;
  name: string;
  handle: string;
  joinedAt: string;
}

export interface Cohort {
  id: string;
  count: number;
  capacity: number;
}

export interface WaitingListState {
  cohorts: Cohort[];
  total: number;
  capacity: number;
}

export interface AddResult {
  added: number;
  creators: Creator[];
  cohorts: Cohort[];
  total: number;
}

export interface OnboardResult {
  onboarded: number;
  creators: Creator[];
  cohorts: Cohort[];
  total: number;
}

export interface HistoryEvent {
  id: number;
  type: "list_created" | "creators_added" | "creators_onboarded" | "capacity_changed";
  count: number;
  detail: { creators?: string[]; capacity?: number; from?: number; to?: number } | null;
  createdAt: string;
}

export interface CapacityResult {
  changed: boolean;
  cohorts: Cohort[];
  total: number;
  capacity: number;
}

async function handleResponse<T>(res: globalThis.Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function getState(): Promise<WaitingListState> {
  const res = await fetch(`${BASE_URL}/state`);
  return handleResponse<WaitingListState>(res);
}

export async function addCreators(count: number): Promise<AddResult> {
  const res = await fetch(`${BASE_URL}/creators`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count }),
  });
  return handleResponse<AddResult>(res);
}

export async function onboardCreators(count: number): Promise<OnboardResult> {
  const res = await fetch(`${BASE_URL}/creators/onboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count }),
  });
  return handleResponse<OnboardResult>(res);
}

export async function updateCapacity(capacity: number): Promise<CapacityResult> {
  const res = await fetch(`${BASE_URL}/capacity`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capacity }),
  });
  return handleResponse<CapacityResult>(res);
}

export async function getHistory(limit = 20): Promise<HistoryEvent[]> {
  const res = await fetch(`${BASE_URL}/history?limit=${limit}`);
  const body = await handleResponse<{ events: HistoryEvent[] }>(res);
  return body.events;
}
