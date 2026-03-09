export const STORAGE_KEYS = {
  theme: 'ryvion_operator_theme',
  hubUrl: 'ryvion_operator_hub_url',
  localApiUrl: 'ryvion_operator_local_api_url',
  authToken: 'ryvion_operator_auth_token',
  authUser: 'ryvion_operator_auth_user',
  connectAccount: 'ryvion_operator_connect_account',
} as const

function safeRead(key: string) {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function safeWrite(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // ignore storage failures
  }
}

export function readStoredValue(key: string) {
  return safeRead(key)
}

export function writeStoredValue(key: string, value: string) {
  safeWrite(key, value)
}

export interface CloudAuthUser {
  buyer_id: string
  email: string
  name: string
  api_key?: string
}

export function readCloudToken() {
  return safeRead(STORAGE_KEYS.authToken)
}

export function writeCloudToken(token: string) {
  safeWrite(STORAGE_KEYS.authToken, token)
}

export function readCloudUser(): CloudAuthUser | null {
  const raw = safeRead(STORAGE_KEYS.authUser)
  if (!raw) return null
  try {
    return JSON.parse(raw) as CloudAuthUser
  } catch {
    return null
  }
}

export function writeCloudUser(user: CloudAuthUser | null) {
  safeWrite(STORAGE_KEYS.authUser, user ? JSON.stringify(user) : '')
}

export function clearCloudAuth() {
  writeCloudToken('')
  writeCloudUser(null)
}
