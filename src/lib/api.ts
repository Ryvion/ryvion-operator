import { invoke } from '@tauri-apps/api/core'
import { readCloudToken, readStoredValue, STORAGE_KEYS } from './storage'

export const DEFAULT_HUB_URL = 'https://ryvion-hub.fly.dev'
export const DEFAULT_LOCAL_API_URL = 'http://127.0.0.1:45890'

export interface OperatorJob {
  job_id: string
  kind: string
  image?: string
  status: string
  started_at?: string
  completed_at?: string
  duration_ms?: number
  result_hash_hex?: string
  blob_url?: string
  exit_code?: number
  error?: string
  metering_units?: number
  receipt_metadata?: Record<string, unknown>
  delivery_object?: string
}

export interface OperatorStatusResponse {
  version: string
  hub_url: string
  public_key_hex: string
  device_type: string
  declared_country?: string
  registered: boolean
  register_error?: string
  latest_version?: string
  last_heartbeat_at?: string
  last_heartbeat_error?: string
  machine: {
    cpu_cores: number
    ram_bytes: number
    gpu_model?: string
    vram_bytes?: number
  }
  runtime: {
    local_api_url: string
    status_message?: string
    docker_cli_present: boolean
    docker_ready: boolean
    docker_gpu_enabled: boolean
    gpu_ready: boolean
    spatial_ready: boolean
    native_inference_supported: boolean
    native_inference_ready: boolean
    native_model?: string
    disk_gb?: number
  }
  metrics: {
    cpu_util?: number
    mem_util?: number
    gpu_util?: number
    power_watts?: number
  }
  current_job?: OperatorJob
  recent_jobs: OperatorJob[]
  last_claim_at?: string
  last_claim_error?: string
  last_payout_at?: string
  last_payout_error?: string
}

export interface OperatorJobsResponse {
  current_job?: OperatorJob
  jobs: OperatorJob[]
}

export interface OperatorLogsResponse {
  lines: string[]
}

export interface OperatorConnectStatusResponse {
  account_id: string
  onboarded: boolean
}

export interface LocalRuntimeProbeResponse {
  platform: string
  api_url: string
  api_host: string
  api_port: number
  api_port_open: boolean
  configured_api_url?: string
  configured_api_port_open: boolean
  api_url_mismatch: boolean
  suggested_api_url: string
  service_installed: boolean
  service_running: boolean
  service_configured_for_api: boolean
  binary_supports_local_api: boolean
  binary_paths: string[]
  log_path?: string
  install_command: string
  start_command?: string
  log_command?: string
  notes: string[]
}

export interface RuntimeActionResponse {
  launched: boolean
  message: string
}

export interface LoginResponse {
  token: string
  buyer_id: string
  email: string
  name: string
  api_key?: string
}

export interface MeResponse {
  buyer_id: string
  email: string
  name: string
  api_key?: string
}

export interface OperatorStatsNode {
  pubkey: string
  status: string
  earnings_cents: number
  paid_earnings_cents: number
  pending_earnings_cents: number
  cpu_util: number
  gpu_util: number
  gpu_model?: string
  region?: string
  country?: string
  country_code?: string
  approx_region?: string
  location_confidence?: string
  verification_source?: string
  last_seen?: number
}

export interface OperatorStatsResponse {
  total_earnings_cents: number
  total_paid_earnings_cents: number
  total_pending_earnings_cents: number
  node_count: number
  nodes: OperatorStatsNode[]
}

export interface ClaimCodeResponse {
  code: string
  expires_in: number
}

function normalizeBase(base: string) {
  return base.trim().replace(/\/+$/, '')
}

export function normalizeEndpoint(base: string) {
  return normalizeBase(base).toLowerCase()
}

export function getStoredHubUrl() {
  const stored = readStoredValue(STORAGE_KEYS.hubUrl).trim()
  return stored || DEFAULT_HUB_URL
}

export function getStoredLocalAPIUrl() {
  const stored = readStoredValue(STORAGE_KEYS.localApiUrl).trim()
  return stored || DEFAULT_LOCAL_API_URL
}

function authHeaders(token?: string) {
  const credential = token ?? readCloudToken()
  if (!credential) return {} as Record<string, string>
  if (credential.split('.').length === 3) return { Authorization: `Bearer ${credential}` } as Record<string, string>
  return { 'X-API-Key': credential } as Record<string, string>
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit & { timeoutMs?: number }) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), init?.timeoutMs ?? 20000)
  const target = `${normalizeBase(baseUrl)}${path}`
  try {
    const response = await fetch(target, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`${response.status} ${response.statusText}: ${body}`)
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timed out while reaching ${target}`)
    }
    if (error instanceof Error && error.message) {
      throw new Error(`Unable to reach ${target}: ${error.message}`)
    }
    throw new Error(`Unable to reach ${target}`)
  } finally {
    window.clearTimeout(timeout)
  }
}

export function getOperatorStatus(baseUrl = getStoredLocalAPIUrl()) {
  return request<OperatorStatusResponse>(baseUrl, '/api/v1/operator/status')
}

export function getOperatorJobs(baseUrl = getStoredLocalAPIUrl()) {
  return request<OperatorJobsResponse>(baseUrl, '/api/v1/operator/jobs')
}

export function getOperatorLogs(limit = 200, baseUrl = getStoredLocalAPIUrl()) {
  return request<OperatorLogsResponse>(baseUrl, `/api/v1/operator/logs?limit=${limit}`)
}

export function claimNode(code: string, baseUrl = getStoredLocalAPIUrl()) {
  return request<{ status: string }>(baseUrl, '/api/v1/operator/claim', {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
}

export function savePayoutPreference(
  stripe_connect_id: string,
  currency: string,
  baseUrl = getStoredLocalAPIUrl(),
) {
  return request<{ status: string }>(baseUrl, '/api/v1/operator/payout', {
    method: 'POST',
    body: JSON.stringify({ stripe_connect_id, currency }),
  })
}

export function createConnectAccount(email: string, country: string, baseUrl = getStoredLocalAPIUrl()) {
  return request<{ account_id: string }>(baseUrl, '/api/v1/operator/connect/create', {
    method: 'POST',
    body: JSON.stringify({ email, country }),
  })
}

export function getConnectOnboardingLink(account_id: string, baseUrl = getStoredLocalAPIUrl()) {
  return request<{ url: string }>(baseUrl, '/api/v1/operator/connect/onboarding-link', {
    method: 'POST',
    body: JSON.stringify({ account_id }),
  })
}

export function getConnectStatus(account_id: string, baseUrl = getStoredLocalAPIUrl()) {
  return request<OperatorConnectStatusResponse>(baseUrl, `/api/v1/operator/connect/status?account_id=${encodeURIComponent(account_id)}`)
}

export function login(baseUrl: string, payload: { email: string; password: string }) {
  return request<LoginResponse>(baseUrl, '/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function signup(baseUrl: string, payload: { email: string; password: string; name: string }) {
  return request<LoginResponse>(baseUrl, '/api/v1/auth/signup', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getMe(baseUrl: string, token?: string) {
  return request<MeResponse>(baseUrl, '/api/v1/auth/me', {
    headers: authHeaders(token),
  })
}

export function getOperatorStats(baseUrl: string, token?: string) {
  return request<OperatorStatsResponse>(baseUrl, '/api/v1/marketplace/operator/stats', {
    headers: authHeaders(token),
  })
}

export function generateClaimCode(baseUrl: string, token?: string) {
  return request<ClaimCodeResponse>(baseUrl, '/api/v1/marketplace/operator/generate-claim-code', {
    method: 'POST',
    headers: authHeaders(token),
  })
}

export function probeLocalRuntime(baseUrl = getStoredLocalAPIUrl()) {
  return invoke<LocalRuntimeProbeResponse>('probe_local_runtime', { apiUrl: baseUrl })
}

export function runLocalRuntimeAction(
  action: 'restart' | 'repair',
  baseUrl = getStoredLocalAPIUrl(),
  hubUrl = getStoredHubUrl(),
) {
  return invoke<RuntimeActionResponse>('run_local_runtime_action', {
    action,
    apiUrl: baseUrl,
    hubUrl,
  })
}
