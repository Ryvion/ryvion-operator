import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import './App.css'
import {
  claimNode,
  createConnectAccount,
  DEFAULT_HUB_URL,
  DEFAULT_LOCAL_API_URL,
  generateClaimCode,
  getConnectOnboardingLink,
  getOperatorDiagnostics,
  getConnectStatus,
  getOperatorJobs,
  getOperatorLogs,
  getOperatorStats,
  getOperatorStatus,
  normalizeEndpoint,
  probeLocalRuntime,
  runLocalRuntimeAction,
  getStoredHubUrl,
  getStoredLocalAPIUrl,
  login,
  type LocalRuntimeProbeResponse,
  type OperatorDiagnosticsResponse,
  savePayoutPreference,
  signup,
  type OperatorJob,
  type OperatorStatusResponse,
  type OperatorStatsResponse,
} from './lib/api'
import {
  formatBytes,
  formatCurrency,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelative,
  shortHash,
} from './lib/format'
import {
  clearCloudAuth,
  type CloudAuthUser,
  readCloudToken,
  readCloudUser,
  readStoredValue,
  STORAGE_KEYS,
  writeCloudToken,
  writeCloudUser,
  writeStoredValue,
} from './lib/storage'

type ThemeMode = 'system' | 'light' | 'dark'
type ViewKey = 'overview' | 'machine' | 'jobs' | 'earnings' | 'diagnostics' | 'settings'
type NoticeTone = 'good' | 'warn' | 'neutral'
type WorkloadReadiness = {
  name: string
  ready: boolean
  reason: string
  requirements: string[]
  blockers: string[]
  recommended?: string
}

type CloudFormState = {
  name: string
  email: string
  password: string
}

const NAV_ITEMS: Array<{ key: ViewKey; label: string; eyebrow: string }> = [
  { key: 'overview', label: 'Overview', eyebrow: 'Runtime' },
  { key: 'machine', label: 'Machine', eyebrow: 'Capacity' },
  { key: 'jobs', label: 'Jobs', eyebrow: 'Execution' },
  { key: 'earnings', label: 'Earnings', eyebrow: 'Cloud' },
  { key: 'diagnostics', label: 'Diagnostics', eyebrow: 'Logs' },
  { key: 'settings', label: 'Settings', eyebrow: 'Control' },
]

function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => (readStoredValue(STORAGE_KEYS.theme) as ThemeMode) || 'system')
  const [activeView, setActiveView] = useState<ViewKey>('overview')
  const [localApiUrl, setLocalApiUrl] = useState(() => getStoredLocalAPIUrl())
  const [hubUrl, setHubUrl] = useState(() => getStoredHubUrl())
  const [status, setStatus] = useState<OperatorStatusResponse | null>(null)
  const [jobs, setJobs] = useState<OperatorJob[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [diagnostics, setDiagnostics] = useState<OperatorDiagnosticsResponse | null>(null)
  const [localError, setLocalError] = useState('')
  const [runtimeProbe, setRuntimeProbe] = useState<LocalRuntimeProbeResponse | null>(null)
  const [runtimeActionBusy, setRuntimeActionBusy] = useState<'restart' | 'repair' | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null)

  const [cloudMode, setCloudMode] = useState<'login' | 'signup'>(() => (readCloudUser() ? 'login' : 'signup'))
  const [cloudForm, setCloudForm] = useState<CloudFormState>({ name: '', email: '', password: '' })
  const [cloudToken, setCloudToken] = useState(() => readCloudToken())
  const [cloudUser, setCloudUser] = useState(() => readCloudUser())
  const [cloudStats, setCloudStats] = useState<OperatorStatsResponse | null>(null)
  const [cloudError, setCloudError] = useState('')
  const [cloudBusy, setCloudBusy] = useState(false)
  const [claimCode, setClaimCode] = useState('')
  const [claimCodeExpiry, setClaimCodeExpiry] = useState<number | null>(null)
  const [claimInput, setClaimInput] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [actionError, setActionError] = useState('')

  const [connectEmail, setConnectEmail] = useState('')
  const [connectCountry, setConnectCountry] = useState('CA')
  const [connectCurrency, setConnectCurrency] = useState('CAD')
  const [connectAccountId, setConnectAccountId] = useState(() => readStoredValue(STORAGE_KEYS.connectAccount))
  const [connectOnboarded, setConnectOnboarded] = useState<boolean | null>(null)

  useEffect(() => {
    writeStoredValue(STORAGE_KEYS.theme, theme)
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const resolved = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
    document.documentElement.dataset.theme = resolved
  }, [theme])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      if (theme !== 'system') return
      document.documentElement.dataset.theme = media.matches ? 'dark' : 'light'
    }
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  useEffect(() => {
    writeStoredValue(STORAGE_KEYS.localApiUrl, localApiUrl)
  }, [localApiUrl])

  useEffect(() => {
    writeStoredValue(STORAGE_KEYS.hubUrl, hubUrl)
  }, [hubUrl])

  useEffect(() => {
    writeStoredValue(STORAGE_KEYS.connectAccount, connectAccountId)
  }, [connectAccountId])

  const openExternal = useCallback(async (url: string) => {
    try {
      await openUrl(url)
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }, [])

  const applyLocalSnapshot = useCallback(
    (
      nextStatus: OperatorStatusResponse,
      nextJobs: OperatorJob[],
      nextLogs: string[],
      nextDiagnostics: OperatorDiagnosticsResponse | null,
      sourceUrl: string,
      options?: { autodetected?: boolean },
    ) => {
      nextStatus.metrics = normalizeMetrics(nextStatus.metrics)
      setStatus(nextStatus)
      setJobs(nextJobs)
      setLogs(nextLogs)
      setDiagnostics(nextDiagnostics)
      setLocalError('')
      setRuntimeProbe(null)
      setLastRefreshAt(new Date())
      if (normalizeEndpoint(localApiUrl) !== normalizeEndpoint(sourceUrl)) {
        setLocalApiUrl(sourceUrl)
      }
      if (nextStatus.runtime.local_api_url && normalizeEndpoint(localApiUrl) !== normalizeEndpoint(nextStatus.runtime.local_api_url)) {
        setLocalApiUrl(nextStatus.runtime.local_api_url)
      }
      if (!readStoredValue(STORAGE_KEYS.hubUrl) && nextStatus.hub_url) {
        setHubUrl(nextStatus.hub_url)
      }
      if (options?.autodetected) {
        setActionMessage(`Connected to detected local runtime at ${sourceUrl}.`)
      }
    },
    [localApiUrl],
  )

  const fetchLocalSnapshot = useCallback(async (baseUrl: string) => {
    const [nextStatus, nextJobs, nextLogs, nextDiagnostics] = await Promise.all([
      getOperatorStatus(baseUrl),
      getOperatorJobs(baseUrl),
      getOperatorLogs(200, baseUrl),
      getOperatorDiagnostics(baseUrl).catch(() => null),
    ])
    return {
      nextStatus,
      nextJobs: nextJobs.jobs,
      nextLogs: nextLogs.lines,
      nextDiagnostics,
    }
  }, [])

  const refreshLocal = useCallback(async () => {
    try {
      const snapshot = await fetchLocalSnapshot(localApiUrl)
      applyLocalSnapshot(snapshot.nextStatus, snapshot.nextJobs, snapshot.nextLogs, snapshot.nextDiagnostics, localApiUrl)
    } catch (error) {
      try {
        const probe = await probeLocalRuntime(localApiUrl)
        setRuntimeProbe(probe)
        const candidateUrls = Array.from(
          new Set(
            [probe.suggested_api_url, probe.configured_api_url, DEFAULT_LOCAL_API_URL, localApiUrl]
              .map((value) => value?.trim() || '')
              .filter(Boolean),
          ),
        ).filter((value) => normalizeEndpoint(value) !== normalizeEndpoint(localApiUrl))

        for (const candidate of candidateUrls) {
          const isLikelyRuntime = normalizeEndpoint(candidate) === normalizeEndpoint(probe.suggested_api_url) ? probe.configured_api_port_open : true
          if (!isLikelyRuntime) continue
          try {
            const snapshot = await fetchLocalSnapshot(candidate)
            applyLocalSnapshot(snapshot.nextStatus, snapshot.nextJobs, snapshot.nextLogs, snapshot.nextDiagnostics, candidate, { autodetected: true })
            return
          } catch {
            // Try the next candidate.
          }
        }

        setLocalError(error instanceof Error ? error.message : 'Failed to reach local operator API')
      } catch {
        setRuntimeProbe(null)
        setLocalError(error instanceof Error ? error.message : 'Failed to reach local operator API')
      }
    } finally {
      setLoading(false)
    }
  }, [applyLocalSnapshot, fetchLocalSnapshot, localApiUrl])

  const refreshCloud = useCallback(async () => {
    if (!cloudToken) {
      setCloudStats(null)
      return
    }
    try {
      const stats = await getOperatorStats(hubUrl, cloudToken)
      setCloudStats(stats)
      setCloudError('')
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : 'Failed to load operator cloud stats')
    }
  }, [cloudToken, hubUrl])

  useEffect(() => {
    void refreshLocal()
    const timer = window.setInterval(() => {
      void refreshLocal()
    }, 10000)
    return () => window.clearInterval(timer)
  }, [refreshLocal])

  useEffect(() => {
    if (!cloudToken) return
    void refreshCloud()
    const timer = window.setInterval(() => {
      void refreshCloud()
    }, 30000)
    return () => window.clearInterval(timer)
  }, [cloudToken, refreshCloud])

  useEffect(() => {
    if (!connectAccountId) {
      setConnectOnboarded(null)
      return
    }
    let active = true
    getConnectStatus(connectAccountId, localApiUrl)
      .then((res) => {
        if (active) setConnectOnboarded(res.onboarded)
      })
      .catch(() => {
        if (active) setConnectOnboarded(null)
      })
    return () => {
      active = false
    }
  }, [connectAccountId, localApiUrl])

  const runtimeHealth = useMemo(() => {
    if (!status) return 'offline'
    if (!status.registered) return 'registering'
    if (status.last_heartbeat_error) return 'degraded'
    return 'healthy'
  }, [status])

  const updateAvailable = useMemo(
    () => Boolean(status?.latest_version && status.latest_version !== status.version),
    [status],
  )

  const runtimeAlerts = useMemo<Array<{ tone: NoticeTone; title: string; message: string }>>(() => {
    if (!status) return []
    const alerts: Array<{ tone: NoticeTone; title: string; message: string }> = []
    if (updateAvailable) {
      alerts.push({
        tone: 'warn',
        title: 'Runtime update available',
        message: `Installed ${status.version}. Latest published node runtime is ${status.latest_version}.`,
      })
    }
    if (status.register_error) {
      alerts.push({
        tone: 'warn',
        title: 'Registration issue',
        message: status.register_error,
      })
    }
    if (status.last_heartbeat_error) {
      alerts.push({
        tone: 'warn',
        title: 'Heartbeat degraded',
        message: status.last_heartbeat_error,
      })
    }
    if (!status.runtime.docker_ready) {
      alerts.push({
        tone: 'neutral',
        title: 'Container workloads unavailable',
        message: 'Docker is not reachable, so media, embedding, and other OCI workloads cannot land on this node.',
      })
    }
    if (!status.declared_country) {
      alerts.push({
        tone: 'neutral',
        title: 'Declared country missing',
        message: 'Country-restricted policy paths require a declared country and higher-trust posture on the control plane.',
      })
    }
    return alerts.slice(0, 4)
  }, [status, updateAvailable])

  const workloadMatrix = useMemo<WorkloadReadiness[]>(() => {
    const runtime = status?.runtime
    const machine = status?.machine
    if (!runtime || !machine) return []
    const declaredCountry = Boolean(status?.declared_country)
    const gpuModel = stringsPresent(machine.gpu_model)
    const vramGB = bytesToGB(machine.vram_bytes)
    const ramGB = bytesToGB(machine.ram_bytes)
    return [
      {
        name: 'Gateway inference',
        ready: runtime.native_inference_ready || runtime.docker_ready,
        reason: runtime.native_inference_ready
          ? 'Native inference runtime is healthy.'
          : runtime.docker_ready
            ? 'Container runtime is ready for gateway-backed jobs.'
            : 'Requires a healthy native runtime or Docker daemon.',
        requirements: ['Native model or Docker runtime', 'Stable CPU/RAM headroom'],
        blockers: [
          ...(runtime.native_inference_ready || runtime.docker_ready ? [] : ['Neither native inference nor Docker is ready']),
        ],
        recommended: runtime.native_inference_ready ? 'Keep the native model loaded for the lowest-latency gateway path.' : 'Bring Docker or the native model path online.',
      },
      {
        name: 'Embeddings pipeline',
        ready: runtime.native_inference_ready || runtime.docker_ready,
        reason: 'Runs through either the native model or the container path.',
        requirements: ['Native model or Docker runtime', 'At least 8 GB system RAM'],
        blockers: [
          ...(runtime.native_inference_ready || runtime.docker_ready ? [] : ['No eligible execution path is ready']),
          ...(ramGB >= 8 ? [] : ['System RAM below the practical embeddings floor']),
        ],
        recommended: 'Embeddings remain more stable when Docker is available and system memory is not saturated.',
      },
      {
        name: 'Video transcode',
        ready: runtime.docker_ready,
        reason: runtime.docker_ready ? 'Docker is available for FFmpeg workloads.' : 'Requires Docker runtime availability.',
        requirements: ['Docker runtime', 'At least 8 GB free disk or scratch space'],
        blockers: [
          ...(runtime.docker_ready ? [] : ['Docker daemon is not reachable']),
          ...((runtime.disk_gb ?? 0) >= 8 ? [] : ['Less than 8 GB scratch capacity reported by health checks']),
        ],
        recommended: 'Keep Docker running before login so transcode jobs can land immediately after heartbeat.',
      },
      {
        name: 'Spatial stages',
        ready: runtime.spatial_ready,
        reason: runtime.spatial_ready ? 'Spatial stage checks are green.' : 'Requires certified runtime and spatial toolchain support.',
        requirements: ['Spatial toolchain ready', 'GPU present', '12 GB VRAM preferred'],
        blockers: [
          ...(runtime.spatial_ready ? [] : ['Spatial runtime checks are not green']),
          ...(gpuModel ? [] : ['No GPU detected for spatial workloads']),
          ...(vramGB >= 12 ? [] : ['VRAM below the preferred spatial threshold']),
        ],
        recommended: 'Use certified GPU hosts for spatial stages; laptop-only posture is usually insufficient.',
      },
      {
        name: 'Sovereign pool',
        ready: Boolean(declaredCountry && status?.registered),
        reason: status?.declared_country
          ? 'Declared country is present. Final eligibility remains policy-controlled by the hub.'
          : 'Declare country and clear policy review before sovereign workloads become eligible.',
        requirements: ['Declared country', 'Registered node', 'Policy approval on the hub'],
        blockers: [
          ...(declaredCountry ? [] : ['Declared country is missing']),
          ...(status?.registered ? [] : ['Node is not registered on the control plane']),
        ],
        recommended: 'Use a stable non-proxy network and declare country before pursuing sovereign routing.',
      },
    ]
  }, [status])

  const handleCloudAuth = useCallback(async () => {
    setCloudBusy(true)
    setCloudError('')
    try {
      const response = cloudMode === 'login'
        ? await login(hubUrl || DEFAULT_HUB_URL, { email: cloudForm.email, password: cloudForm.password })
        : await signup(hubUrl || DEFAULT_HUB_URL, {
            name: cloudForm.name,
            email: cloudForm.email,
            password: cloudForm.password,
          })
      writeCloudToken(response.token)
      writeCloudUser({
        buyer_id: response.buyer_id,
        email: response.email,
        name: response.name,
        api_key: response.api_key,
      })
      setCloudToken(response.token)
      setCloudUser({
        buyer_id: response.buyer_id,
        email: response.email,
        name: response.name,
        api_key: response.api_key,
      })
      setActionMessage('Cloud account connected.')
      await refreshCloud()
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : 'Authentication failed')
    } finally {
      setCloudBusy(false)
    }
  }, [cloudForm, cloudMode, hubUrl, refreshCloud])

  const handleGenerateClaimCode = useCallback(async () => {
    if (!cloudToken) return
    setActionError('')
    try {
      const response = await generateClaimCode(hubUrl, cloudToken)
      setClaimCode(response.code)
      setClaimCodeExpiry(Date.now() + response.expires_in * 1000)
      setActionMessage('Generated a new node claim code.')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to create claim code')
    }
  }, [cloudToken, hubUrl])

  const handleClaimNode = useCallback(async () => {
    setActionError('')
    try {
      await claimNode(claimInput.trim(), localApiUrl)
      setActionMessage('Node claimed successfully.')
      setClaimInput('')
      await refreshLocal()
      if (cloudToken) await refreshCloud()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Claim failed')
    }
  }, [claimInput, localApiUrl, refreshCloud, refreshLocal, cloudToken])

  const handleCreateConnect = useCallback(async () => {
    setActionError('')
    try {
      const response = await createConnectAccount(connectEmail.trim(), connectCountry.trim(), localApiUrl)
      setConnectAccountId(response.account_id)
      setActionMessage('Created Connect account. Open onboarding next.')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to create Connect account')
    }
  }, [connectCountry, connectEmail, localApiUrl])

  const handleOpenOnboarding = useCallback(async () => {
    if (!connectAccountId) return
    setActionError('')
    try {
      const response = await getConnectOnboardingLink(connectAccountId, localApiUrl)
      await openExternal(response.url)
      setActionMessage('Opened Stripe onboarding in the browser.')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to open onboarding')
    }
  }, [connectAccountId, localApiUrl, openExternal])

  const handleSavePayout = useCallback(async () => {
    if (!connectAccountId) return
    setActionError('')
    try {
      await savePayoutPreference(connectAccountId, connectCurrency, localApiUrl)
      setActionMessage('Saved payout destination on the node.')
      const latest = await getConnectStatus(connectAccountId, localApiUrl)
      setConnectOnboarded(latest.onboarded)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to save payout settings')
    }
  }, [connectAccountId, connectCurrency, localApiUrl])

  const handleCopy = useCallback(async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setActionMessage(message)
    } catch {
      setActionError('Clipboard access is unavailable.')
    }
  }, [])

  const handleRuntimeAction = useCallback(async (action: 'restart' | 'repair') => {
    setRuntimeActionBusy(action)
    setActionError('')
    try {
      const response = await runLocalRuntimeAction(action, localApiUrl, status?.hub_url || hubUrl || DEFAULT_HUB_URL)
      setActionMessage(response.message)
      window.setTimeout(() => {
        void refreshLocal()
      }, action === 'repair' ? 5000 : 2500)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to run local runtime action')
    } finally {
      setRuntimeActionBusy(null)
    }
  }, [hubUrl, localApiUrl, refreshLocal, status?.hub_url])

  const handleRefreshConnectStatus = useCallback(async () => {
    if (!connectAccountId) return
    setActionError('')
    try {
      const latest = await getConnectStatus(connectAccountId, localApiUrl)
      setConnectOnboarded(latest.onboarded)
      setActionMessage(latest.onboarded ? 'Payout account is onboarded.' : 'Payout account still requires onboarding.')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to refresh payout status')
    }
  }, [connectAccountId, localApiUrl])

  const signOut = useCallback(() => {
    clearCloudAuth()
    setCloudToken('')
    setCloudUser(null)
    setCloudStats(null)
    setClaimCode('')
    setClaimCodeExpiry(null)
    setActionMessage('Cloud account disconnected.')
  }, [])

  const currentJob = status?.current_job ?? null

  return (
    <div className="operator-shell">
      <aside className="operator-sidebar">
        <button className="brand-lockup" onClick={() => void openExternal('https://ryvion.ai')}>
          <span className="brand-mark" aria-hidden="true">R</span>
          <span>
            <strong>Ryvion Operator</strong>
            <small>Local node control plane</small>
          </span>
        </button>
        <nav className="sidebar-nav" aria-label="Operator sections">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              className={item.key === activeView ? 'sidebar-link is-active' : 'sidebar-link'}
              onClick={() => setActiveView(item.key)}
              aria-current={item.key === activeView ? 'page' : undefined}
            >
              <span>{item.eyebrow}</span>
              <strong>{item.label}</strong>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <StatusPill tone={runtimeHealth === 'healthy' ? 'good' : runtimeHealth === 'degraded' ? 'warn' : 'neutral'}>
            {runtimeHealth === 'healthy' ? 'Node ready' : runtimeHealth === 'degraded' ? 'Node degraded' : 'Waiting for node'}
          </StatusPill>
          <p>{status?.public_key_hex ? shortHash(status.public_key_hex, 8) : 'Local node API not connected yet.'}</p>
        </div>
      </aside>

      <main className="operator-main" id="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Operator workspace</p>
            <h1>{NAV_ITEMS.find((item) => item.key === activeView)?.label}</h1>
          </div>
          <div className="topbar-actions">
            <div className="quick-stat">
              <span>Hub</span>
              <strong>{status?.hub_url || hubUrl || DEFAULT_HUB_URL}</strong>
            </div>
            <button className="ghost-button" onClick={() => void refreshLocal()}>
              Refresh runtime
            </button>
            <ThemeToggle value={theme} onChange={setTheme} />
          </div>
        </header>

        {(actionMessage || actionError || localError || cloudError) && (
          <section className="notice-stack" aria-live="polite">
            {actionMessage ? <Notice tone="good">{actionMessage}</Notice> : null}
            {actionError ? <Notice tone="warn">{actionError}</Notice> : null}
            {localError ? <Notice tone="warn">{localError}</Notice> : null}
            {cloudError ? <Notice tone="warn">{cloudError}</Notice> : null}
          </section>
        )}

        {loading && !status ? (
          <section className="panel empty-panel">
            <h2>Connecting to the local node API</h2>
            <p>
              The operator app expects `ryvion-node` to expose the local API on {DEFAULT_LOCAL_API_URL}. If the node is not
              running yet, start it first and this surface will attach automatically.
            </p>
          </section>
        ) : null}

        {!loading && !status ? (
          <section className="panel empty-panel">
            <h2>Local runtime is unavailable</h2>
            <p>
              The desktop app could not reach the local node API. Check that the service is running, or update the local API
              URL in settings if you changed the port.
            </p>
            {runtimeProbe ? (
              <div className="stack top-gap">
                <div className="capacity-grid">
                  <MiniStat label="API target" value={`${runtimeProbe.api_host}:${runtimeProbe.api_port}`} />
                  <MiniStat label="Port reachability" value={runtimeProbe.api_port_open ? 'Listening' : 'Closed'} />
                  <MiniStat label="Detected API" value={runtimeProbe.configured_api_url || runtimeProbe.suggested_api_url} />
                  <MiniStat label="Service" value={runtimeProbe.service_installed ? (runtimeProbe.service_running ? 'Running' : 'Installed') : 'Missing'} />
                  <MiniStat label="Service config" value={runtimeProbe.service_configured_for_api ? 'API enabled' : 'Legacy'} />
                  <MiniStat label="Runtime binary" value={runtimeProbe.binary_supports_local_api ? 'Current' : 'Legacy'} />
                  <MiniStat label="Platform" value={runtimeProbe.platform} />
                </div>
                {runtimeProbe.api_url_mismatch ? (
                  <Notice tone="neutral">
                    <strong>Saved API target differs from the detected runtime endpoint.</strong>
                    <p>
                      Stored: {runtimeProbe.api_url}
                      <br />
                      Detected: {runtimeProbe.configured_api_url || runtimeProbe.suggested_api_url}
                    </p>
                  </Notice>
                ) : null}
                {runtimeProbe.notes.length ? (
                  <div>
                    <p className="eyebrow">Diagnostics</p>
                    <ul className="bullet-list">
                      {runtimeProbe.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {runtimeProbe.binary_paths.length ? (
                  <div>
                    <p className="eyebrow">Detected binaries</p>
                    <div className="stack">
                      {runtimeProbe.binary_paths.map((path) => (
                        <MiniStat key={path} label="Binary" value={path} />
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="inline-actions">
                  {runtimeProbe.api_url_mismatch ? (
                    <button
                      className="primary-button"
                      onClick={() => setLocalApiUrl(runtimeProbe.configured_api_url || runtimeProbe.suggested_api_url)}
                      disabled={runtimeActionBusy !== null}
                    >
                      Use detected endpoint
                    </button>
                  ) : null}
                  {runtimeProbe.service_installed ? (
                    <button
                      className="primary-button"
                      onClick={() => void handleRuntimeAction('restart')}
                      disabled={runtimeActionBusy !== null}
                    >
                      {runtimeActionBusy === 'restart' ? 'Restarting…' : 'Restart service'}
                    </button>
                  ) : null}
                  <button
                    className="ghost-button"
                    onClick={() => void handleRuntimeAction('repair')}
                    disabled={runtimeActionBusy !== null}
                  >
                    {runtimeActionBusy === 'repair' ? 'Opening installer…' : 'Run repair installer'}
                  </button>
                  <button className="ghost-button" onClick={() => void handleCopy(runtimeProbe.install_command, 'Copied install command.')}>Copy install command</button>
                  {runtimeProbe.start_command ? <button className="ghost-button" onClick={() => void handleCopy(runtimeProbe.start_command!, 'Copied start command.')}>Copy start command</button> : null}
                  {runtimeProbe.log_command ? <button className="ghost-button" onClick={() => void handleCopy(runtimeProbe.log_command!, 'Copied log command.')}>Copy log command</button> : null}
                  <button className="ghost-button" onClick={() => void openExternal('https://ryvion.ai/operators')}>Open operator guide</button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {status ? (
          <>
            {activeView === 'overview' ? (
              <OverviewView
                status={status}
                currentJob={currentJob}
                jobs={jobs}
                cloudStats={cloudStats}
                lastRefreshAt={lastRefreshAt}
                runtimeAlerts={runtimeAlerts}
                updateAvailable={updateAvailable}
                onCopy={handleCopy}
                onOpenExternal={openExternal}
              />
            ) : null}
            {activeView === 'machine' ? <MachineView status={status} workloadMatrix={workloadMatrix} /> : null}
            {activeView === 'jobs' ? <JobsView currentJob={currentJob} jobs={jobs} onCopy={handleCopy} onOpenExternal={openExternal} /> : null}
            {activeView === 'earnings' ? (
              <EarningsView
                status={status}
                cloudToken={cloudToken}
                cloudUser={cloudUser}
                cloudStats={cloudStats}
                cloudMode={cloudMode}
                cloudForm={cloudForm}
                claimCode={claimCode}
                claimCodeExpiry={claimCodeExpiry}
                claimInput={claimInput}
                connectEmail={connectEmail}
                connectCountry={connectCountry}
                connectCurrency={connectCurrency}
                connectAccountId={connectAccountId}
                connectOnboarded={connectOnboarded}
                cloudBusy={cloudBusy}
                onCloudModeChange={setCloudMode}
                onCloudFormChange={setCloudForm}
                onAuth={handleCloudAuth}
                onGenerateClaimCode={handleGenerateClaimCode}
                onClaimInputChange={setClaimInput}
                onClaimNode={handleClaimNode}
                onConnectEmailChange={setConnectEmail}
                onConnectCountryChange={setConnectCountry}
                onConnectCurrencyChange={setConnectCurrency}
                onConnectAccountIdChange={setConnectAccountId}
                onCreateConnect={handleCreateConnect}
                onOpenOnboarding={handleOpenOnboarding}
                onSavePayout={handleSavePayout}
                onRefreshConnectStatus={handleRefreshConnectStatus}
                onCopy={handleCopy}
                onSignOut={signOut}
              />
            ) : null}
            {activeView === 'diagnostics' ? (
              <DiagnosticsView
                status={status}
                logs={logs}
                diagnostics={diagnostics}
                localApiUrl={localApiUrl}
                onCopy={handleCopy}
                onOpenExternal={openExternal}
                updateAvailable={updateAvailable}
              />
            ) : null}
            {activeView === 'settings' ? (
              <SettingsView
                theme={theme}
                localApiUrl={localApiUrl}
                hubUrl={hubUrl}
                declaredCountry={status.declared_country}
                runtimeProbe={runtimeProbe}
                onThemeChange={setTheme}
                onLocalApiUrlChange={setLocalApiUrl}
                onHubUrlChange={setHubUrl}
                onOpenExternal={openExternal}
              />
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  )
}

function OverviewView({
  status,
  currentJob,
  jobs,
  cloudStats,
  lastRefreshAt,
  runtimeAlerts,
  updateAvailable,
  onCopy,
  onOpenExternal,
}: {
  status: OperatorStatusResponse
  currentJob: OperatorJob | null
  jobs: OperatorJob[]
  cloudStats: OperatorStatsResponse | null
  lastRefreshAt: Date | null
  runtimeAlerts: Array<{ tone: NoticeTone; title: string; message: string }>
  updateAvailable: boolean
  onCopy: (value: string, message: string) => void
  onOpenExternal: (url: string) => void
}) {
  const metrics = status.metrics
  return (
    <div className="view-grid">
      <section className="metric-grid metric-grid--four">
        <MetricCard title="Node state" value={status.registered ? 'Registered' : 'Pending'} detail={status.last_heartbeat_error || status.register_error || 'Control plane reachable.'} />
        <MetricCard title="Docker" value={status.runtime.docker_ready ? 'Ready' : 'Unavailable'} detail={status.runtime.docker_gpu_enabled ? 'GPU runtime enabled.' : 'CPU / general container path only.'} />
        <MetricCard title="Machine load" value={formatPercent(Math.max(metrics.cpu_util ?? 0, metrics.mem_util ?? 0))} detail={`CPU ${formatPercent(metrics.cpu_util)} · RAM ${formatPercent(metrics.mem_util)} · GPU ${formatPercent(metrics.gpu_util)}`} />
        <MetricCard title="Cloud earnings" value={cloudStats ? formatCurrency(cloudStats.total_earnings_cents) : 'Connect account'} detail={cloudStats ? `${cloudStats.node_count} linked nodes · ${formatCurrency(cloudStats.total_pending_earnings_cents)} pending` : 'Sign in to see operator earnings and claim codes.'} />
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Local runtime</p>
            <h2>Node posture</h2>
          </div>
          <StatusPill tone={status.last_heartbeat_error ? 'warn' : 'good'}>
            {status.last_heartbeat_error ? 'Heartbeat degraded' : 'Heartbeat healthy'}
          </StatusPill>
        </div>
        <dl className="definition-list">
          <div>
            <dt>Public key</dt>
            <dd>
              {shortHash(status.public_key_hex, 10)}{' '}
              <button className="text-button" onClick={() => void onCopy(status.public_key_hex, 'Copied node public key.')}>Copy</button>
            </dd>
          </div>
          <div>
            <dt>Declared country</dt>
            <dd>{status.declared_country || 'Not declared'}</dd>
          </div>
          <div>
            <dt>Latest heartbeat</dt>
            <dd>{status.last_heartbeat_at ? `${formatDateTime(status.last_heartbeat_at)} (${formatRelative(status.last_heartbeat_at)})` : 'Waiting for first heartbeat'}</dd>
          </div>
          <div>
            <dt>Refresh</dt>
            <dd>{lastRefreshAt ? `${formatDateTime(lastRefreshAt.toISOString())} (${formatRelative(lastRefreshAt.toISOString())})` : 'Now'}</dd>
          </div>
        </dl>
        <div className="runtime-checks">
          <CheckRow label="Docker CLI" state={status.runtime.docker_cli_present} />
          <CheckRow label="Container runtime" state={status.runtime.docker_ready} />
          <CheckRow label="GPU runtime" state={status.runtime.docker_gpu_enabled || status.runtime.gpu_ready} />
          <CheckRow label="Native inference" state={status.runtime.native_inference_ready} detail={status.runtime.native_model || 'No native model loaded'} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Operator posture</p>
            <h2>Current blockers and actions</h2>
          </div>
          {updateAvailable ? <StatusPill tone="warn">Update available</StatusPill> : null}
        </div>
        {runtimeAlerts.length ? (
          <div className="notice-stack">
            {runtimeAlerts.map((alert) => (
              <Notice key={alert.title} tone={alert.tone}>
                <strong>{alert.title}</strong>
                <p>{alert.message}</p>
              </Notice>
            ))}
          </div>
        ) : (
          <div className="empty-state compact-empty">
            <h3>No immediate blockers</h3>
            <p>The node is in a clean state for its current workload class and policy posture.</p>
          </div>
        )}
        <div className="inline-actions top-gap">
          <button className="ghost-button" onClick={() => void onOpenExternal('https://ryvion.ai/status')}>Check runtime status</button>
          <button className="ghost-button" onClick={() => void onOpenExternal('https://ryvion.ai/operators')}>Open operator guide</button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Active work</p>
            <h2>Current execution</h2>
          </div>
        </div>
        {currentJob ? (
          <div className="job-hero">
            <strong>{currentJob.kind}</strong>
            <p>{currentJob.status === 'running' ? 'The node is actively executing a workload.' : 'The latest workload is now complete.'}</p>
            <div className="job-meta-grid">
              <MiniStat label="Job ID" value={shortHash(currentJob.job_id, 8)} />
              <MiniStat label="Started" value={formatRelative(currentJob.started_at)} />
              <MiniStat label="Duration" value={formatDuration(currentJob.duration_ms)} />
              <MiniStat label="Units" value={String(currentJob.metering_units ?? '—')} />
            </div>
          </div>
        ) : (
          <div className="empty-state compact-empty">
            <h3>No workload is running</h3>
            <p>The runtime is idle. Recent completed jobs stay below for review.</p>
          </div>
        )}
        <div className="timeline-list">
          {jobs.slice(0, 3).map((job) => (
            <article key={job.job_id} className="timeline-item">
              <div>
                <strong>{job.kind}</strong>
                <p>{job.status === 'failed' ? job.error || 'Execution failed.' : 'Receipt recorded by the node.'}</p>
              </div>
              <span>{formatRelative(job.completed_at || job.started_at)}</span>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

function MachineView({ status, workloadMatrix }: { status: OperatorStatusResponse; workloadMatrix: WorkloadReadiness[] }) {
  const metrics = status.metrics
  const freeRam = status.machine.ram_bytes ? Math.round(status.machine.ram_bytes * (1 - (metrics.mem_util ?? 0) / 100)) : 0
  const freeVRAM = status.machine.vram_bytes ? Math.round(status.machine.vram_bytes * (1 - (metrics.gpu_util ?? 0) / 100)) : 0
  const cpuHeadroom = Math.max(0, 100 - (metrics.cpu_util ?? 0))
  return (
    <div className="view-grid">
      <section className="metric-grid metric-grid--four">
        <MetricCard title="CPU" value={`${status.machine.cpu_cores} cores`} detail={`Current utilization ${formatPercent(metrics.cpu_util)}`} />
        <MetricCard title="System RAM" value={formatBytes(status.machine.ram_bytes)} detail={`Approx. free ${formatBytes(freeRam)}`} />
        <MetricCard title="GPU" value={status.machine.gpu_model || 'CPU node'} detail={status.machine.vram_bytes ? `${formatBytes(status.machine.vram_bytes)} VRAM` : 'No discrete VRAM reported'} />
        <MetricCard title="Disk posture" value={status.runtime.disk_gb ? `${status.runtime.disk_gb} GB` : '—'} detail={status.runtime.status_message || 'Derived from health report tokens.'} />
      </section>

      <section className="panel panel-span-2">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Resource headroom</p>
            <h2>Live operating capacity</h2>
          </div>
        </div>
        <div className="capacity-grid">
          <div className="mini-stat">
            <span>CPU headroom</span>
            <strong>{formatPercent(cpuHeadroom)}</strong>
          </div>
          <div className="mini-stat">
            <span>RAM free</span>
            <strong>{formatBytes(freeRam)}</strong>
          </div>
          <div className="mini-stat">
            <span>VRAM free</span>
            <strong>{status.machine.vram_bytes ? formatBytes(freeVRAM) : '—'}</strong>
          </div>
          <div className="mini-stat">
            <span>Power draw</span>
            <strong>{metrics.power_watts ? `${metrics.power_watts.toFixed(0)} W` : '—'}</strong>
          </div>
        </div>
        <div className="runtime-checks top-gap">
          <LoadRow label="CPU" value={metrics.cpu_util ?? 0} />
          <LoadRow label="Memory" value={metrics.mem_util ?? 0} />
          <LoadRow label="GPU" value={metrics.gpu_util ?? 0} />
          <LoadRow label="Power" value={(metrics.power_watts ?? 0) / 5} text={`${(metrics.power_watts ?? 0).toFixed(0)} W`} />
        </div>
      </section>

      <section className="panel panel-span-2">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Workload readiness</p>
            <h2>What this machine can run and why</h2>
          </div>
        </div>
        <div className="workload-card-grid">
          {workloadMatrix.map((item) => (
            <article key={item.name} className="workload-card">
              <div>
                <div className="panel-header panel-header--tight">
                  <strong>{item.name}</strong>
                  <StatusPill tone={item.ready ? 'good' : 'neutral'}>{item.ready ? 'Eligible' : 'Not ready'}</StatusPill>
                </div>
                <p>{item.reason}</p>
                <div className="stack top-gap">
                  <div>
                    <p className="eyebrow">Requirements</p>
                    <div className="chip-list">
                      {item.requirements.map((requirement) => (
                        <span key={requirement} className="requirement-chip">{requirement}</span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="eyebrow">{item.blockers.length ? 'Current blockers' : 'Blockers'}</p>
                    {item.blockers.length ? (
                      <ul className="bullet-list">
                        {item.blockers.map((blocker) => (
                          <li key={blocker}>{blocker}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="support-copy">No active blockers are reported for this workload class.</p>
                    )}
                  </div>
                  {item.recommended ? (
                    <div>
                      <p className="eyebrow">Recommended action</p>
                      <p className="support-copy">{item.recommended}</p>
                    </div>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

function JobsView({
  currentJob,
  jobs,
  onCopy,
  onOpenExternal,
}: {
  currentJob: OperatorJob | null
  jobs: OperatorJob[]
  onCopy: (value: string, message: string) => void
  onOpenExternal: (url: string) => void
}) {
  return (
    <div className="view-grid">
      <section className="panel panel-span-2">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Execution log</p>
            <h2>Recent workloads</h2>
          </div>
        </div>
        <div className="table-shell">
          <table className="data-table">
            <thead>
              <tr>
                <th>Workload</th>
                <th>Status</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Receipt</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.job_id}>
                  <td>
                    <strong>{job.kind}</strong>
                    <div className="cell-subtitle">{shortHash(job.job_id, 8)}</div>
                  </td>
                  <td><StatusPill tone={job.status === 'completed' ? 'good' : job.status === 'failed' ? 'warn' : 'neutral'}>{job.status}</StatusPill></td>
                  <td>{formatDateTime(job.started_at)}</td>
                  <td>{formatDuration(job.duration_ms)}</td>
                  <td>
                    <div className="inline-actions inline-actions--tight">
                      {job.result_hash_hex ? (
                        <button className="text-button" onClick={() => void onCopy(job.result_hash_hex!, 'Copied result hash.')}>Copy hash</button>
                      ) : null}
                      {job.blob_url ? (
                        <button className="text-button" onClick={() => void onOpenExternal(job.blob_url!)}>Open result</button>
                      ) : null}
                      {!job.result_hash_hex && !job.blob_url ? '—' : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Current job</p>
            <h2>Focused details</h2>
          </div>
        </div>
        {currentJob ? (
          <div className="stack">
            <MiniStat label="Job" value={shortHash(currentJob.job_id, 8)} />
            <MiniStat label="Kind" value={currentJob.kind} />
            <MiniStat label="Image" value={currentJob.image || 'native'} />
            <MiniStat label="Started" value={formatDateTime(currentJob.started_at)} />
            <MiniStat label="Duration" value={formatDuration(currentJob.duration_ms)} />
            <MiniStat label="Blob" value={currentJob.blob_url ? 'Uploaded' : 'None'} />
            <MiniStat label="Exit code" value={currentJob.exit_code != null ? String(currentJob.exit_code) : '—'} />
            <div className="inline-actions">
              {currentJob.blob_url ? <button className="ghost-button" onClick={() => void onOpenExternal(currentJob.blob_url!)}>Open result</button> : null}
              {currentJob.result_hash_hex ? <button className="ghost-button" onClick={() => void onCopy(currentJob.result_hash_hex!, 'Copied result hash.')}>Copy result hash</button> : null}
            </div>
          </div>
        ) : (
          <div className="empty-state compact-empty">
            <h3>No active job</h3>
            <p>Recent jobs remain available in the table for troubleshooting and payout review.</p>
          </div>
        )}
      </section>
    </div>
  )
}

function EarningsView(props: {
  status: OperatorStatusResponse
  cloudToken: string
  cloudUser: CloudAuthUser | null
  cloudStats: OperatorStatsResponse | null
  cloudMode: 'login' | 'signup'
  cloudForm: CloudFormState
  claimCode: string
  claimCodeExpiry: number | null
  claimInput: string
  connectEmail: string
  connectCountry: string
  connectCurrency: string
  connectAccountId: string
  connectOnboarded: boolean | null
  cloudBusy: boolean
  onCloudModeChange: (mode: 'login' | 'signup') => void
  onCloudFormChange: (next: CloudFormState) => void
  onAuth: () => void
  onGenerateClaimCode: () => void
  onClaimInputChange: (value: string) => void
  onClaimNode: () => void
  onConnectEmailChange: (value: string) => void
  onConnectCountryChange: (value: string) => void
  onConnectCurrencyChange: (value: string) => void
  onConnectAccountIdChange: (value: string) => void
  onCreateConnect: () => void
  onOpenOnboarding: () => void
  onSavePayout: () => void
  onRefreshConnectStatus: () => void
  onCopy: (value: string, message: string) => void
  onSignOut: () => void
}) {
  const {
    status,
    cloudToken,
    cloudUser,
    cloudStats,
    cloudMode,
    cloudForm,
    claimCode,
    claimCodeExpiry,
    claimInput,
    connectEmail,
    connectCountry,
    connectCurrency,
    connectAccountId,
    connectOnboarded,
    cloudBusy,
    onCloudModeChange,
    onCloudFormChange,
    onAuth,
    onGenerateClaimCode,
    onClaimInputChange,
    onClaimNode,
    onConnectEmailChange,
    onConnectCountryChange,
    onConnectCurrencyChange,
    onConnectAccountIdChange,
    onCreateConnect,
    onOpenOnboarding,
    onSavePayout,
    onRefreshConnectStatus,
    onCopy,
    onSignOut,
  } = props

  return (
    <div className="view-grid">
      <section className="metric-grid metric-grid--four">
        <MetricCard title="Linked nodes" value={cloudStats ? String(cloudStats.node_count) : '—'} detail={cloudUser ? 'Nodes attached to this operator account.' : 'Cloud sign-in required.'} />
        <MetricCard title="Total earnings" value={cloudStats ? formatCurrency(cloudStats.total_earnings_cents) : '—'} detail="Operator earnings across claimed nodes." />
        <MetricCard title="Pending" value={cloudStats ? formatCurrency(cloudStats.total_pending_earnings_cents) : '—'} detail="Awaiting payout execution." />
        <MetricCard title="Paid" value={cloudStats ? formatCurrency(cloudStats.total_paid_earnings_cents) : '—'} detail="Already settled to payout rails." />
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Cloud account</p>
            <h2>Operator identity</h2>
          </div>
          {cloudUser ? <StatusPill tone="good">Connected</StatusPill> : null}
        </div>
        {cloudUser ? (
          <div className="stack">
            <MiniStat label="Operator" value={cloudUser.name} />
            <MiniStat label="Email" value={cloudUser.email} />
            {cloudUser.api_key ? <MiniStat label="API key" value={cloudUser.api_key} /> : null}
            <div className="inline-actions">
              {cloudUser.api_key ? <button className="ghost-button" onClick={() => onCopy(cloudUser.api_key!, 'Copied buyer API key.')}>Copy API key</button> : null}
              <button className="ghost-button" onClick={onSignOut}>Sign out</button>
            </div>
          </div>
        ) : (
          <div className="auth-form">
            <div className="segmented-control" role="tablist" aria-label="Cloud auth mode">
              <button className={cloudMode === 'login' ? 'segment is-active' : 'segment'} onClick={() => onCloudModeChange('login')}>Sign in</button>
              <button className={cloudMode === 'signup' ? 'segment is-active' : 'segment'} onClick={() => onCloudModeChange('signup')}>Create account</button>
            </div>
            {cloudMode === 'signup' ? (
              <label>
                <span>Name</span>
                <input value={cloudForm.name} onChange={(event) => onCloudFormChange({ ...cloudForm, name: event.target.value })} />
              </label>
            ) : null}
            <label>
              <span>Email</span>
              <input value={cloudForm.email} onChange={(event) => onCloudFormChange({ ...cloudForm, email: event.target.value })} />
            </label>
            <label>
              <span>Password</span>
              <input type="password" value={cloudForm.password} onChange={(event) => onCloudFormChange({ ...cloudForm, password: event.target.value })} />
            </label>
            <button className="primary-button" onClick={onAuth} disabled={cloudBusy}>{cloudBusy ? 'Connecting…' : cloudMode === 'login' ? 'Sign in' : 'Create account'}</button>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Node linking</p>
            <h2>Claim this device</h2>
          </div>
        </div>
        <div className="stack">
          <p className="support-copy">Generate a short claim code from your operator account, then redeem it locally to bind this node.</p>
          <div className="inline-actions">
            <button className="ghost-button" onClick={onGenerateClaimCode} disabled={!cloudToken}>Generate code</button>
            {claimCode ? <button className="ghost-button" onClick={() => onCopy(claimCode, 'Copied claim code.')}>Copy code</button> : null}
          </div>
          {claimCode ? <Notice tone="neutral">{claimCode} {claimCodeExpiry ? `· expires ${formatRelative(claimCodeExpiry)}` : ''}</Notice> : null}
          <label>
            <span>Redeem code on this node</span>
            <input value={claimInput} onChange={(event) => onClaimInputChange(event.target.value.toUpperCase())} placeholder="RYV-1234" />
          </label>
          <button className="primary-button" onClick={onClaimNode} disabled={!claimInput.trim()}>Claim node</button>
          <p className="support-copy">Current node: {shortHash(status.public_key_hex, 8)}</p>
        </div>
      </section>

      <section className="panel panel-span-2">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Payout onboarding</p>
            <h2>Connect Stripe for payouts</h2>
          </div>
          {connectOnboarded != null ? <StatusPill tone={connectOnboarded ? 'good' : 'warn'}>{connectOnboarded ? 'Onboarded' : 'Needs onboarding'}</StatusPill> : null}
        </div>
        <div className="form-grid">
          <label>
            <span>Payout email</span>
            <input value={connectEmail} onChange={(event) => onConnectEmailChange(event.target.value)} placeholder="operator@company.com" />
          </label>
          <label>
            <span>Country</span>
            <input value={connectCountry} onChange={(event) => onConnectCountryChange(event.target.value.toUpperCase())} maxLength={2} />
          </label>
          <label>
            <span>Currency</span>
            <select value={connectCurrency} onChange={(event) => onConnectCurrencyChange(event.target.value)}>
              <option value="CAD">CAD</option>
              <option value="USD">USD</option>
            </select>
          </label>
          <label>
            <span>Connect account</span>
            <input value={connectAccountId} onChange={(event) => onConnectAccountIdChange(event.target.value)} placeholder="acct_…" />
          </label>
        </div>
        <div className="inline-actions">
          <button className="ghost-button" onClick={onCreateConnect} disabled={!connectEmail.trim()}>Create account</button>
          <button className="ghost-button" onClick={onOpenOnboarding} disabled={!connectAccountId}>Open onboarding</button>
          <button className="ghost-button" onClick={onRefreshConnectStatus} disabled={!connectAccountId}>Refresh status</button>
          <button className="primary-button" onClick={onSavePayout} disabled={!connectAccountId}>Save payout</button>
        </div>
      </section>

      {cloudStats ? (
        <section className="panel panel-span-2">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Operator fleet</p>
              <h2>Claimed nodes</h2>
            </div>
          </div>
          <div className="table-shell">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Status</th>
                  <th>Location</th>
                  <th>Compute</th>
                  <th>Earnings</th>
                </tr>
              </thead>
              <tbody>
                {cloudStats.nodes.map((node) => (
                  <tr key={node.pubkey}>
                    <td>{shortHash(node.pubkey, 8)}</td>
                    <td><StatusPill tone={node.status === 'online' ? 'good' : node.status === 'stale' ? 'warn' : 'neutral'}>{node.status}</StatusPill></td>
                    <td>{node.country || node.region || '—'}</td>
                    <td>{node.gpu_model || 'CPU node'}</td>
                    <td>{formatCurrency(node.earnings_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  )
}

function DiagnosticsView({
  status,
  logs,
  diagnostics,
  localApiUrl,
  onCopy,
  onOpenExternal,
  updateAvailable,
}: {
  status: OperatorStatusResponse
  logs: string[]
  diagnostics: OperatorDiagnosticsResponse | null
  localApiUrl: string
  onCopy: (value: string, message: string) => void
  onOpenExternal: (url: string) => void
  updateAvailable: boolean
}) {
  return (
    <div className="view-grid">
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Endpoints</p>
            <h2>Runtime interfaces</h2>
          </div>
        </div>
        <dl className="definition-list">
          <div><dt>Local API</dt><dd>{localApiUrl}</dd></div>
          <div><dt>Hub</dt><dd>{status.hub_url}</dd></div>
          <div><dt>Version</dt><dd>{status.version}{status.latest_version ? ` · latest ${status.latest_version}` : ''}</dd></div>
          <div><dt>Native model</dt><dd>{status.runtime.native_model || 'Not loaded'}</dd></div>
        </dl>
        <div className="inline-actions">
          <button className="ghost-button" onClick={() => onCopy(status.public_key_hex, 'Copied node public key.')}>Copy public key</button>
          {diagnostics ? <button className="ghost-button" onClick={() => onCopy(JSON.stringify(diagnostics, null, 2), 'Copied diagnostics snapshot.')}>Copy diagnostics JSON</button> : null}
          <button className="ghost-button" onClick={() => onCopy(logs.join('\n'), 'Copied log tail.')}>Copy logs</button>
          <button className="ghost-button" onClick={() => void onOpenExternal(`${localApiUrl}/healthz`)}>Open local health</button>
          <button className="ghost-button" onClick={() => void onOpenExternal(`${status.hub_url}/healthz`)}>Open hub health</button>
          <button className="ghost-button" onClick={() => void onOpenExternal('https://ryvion.ai/status')}>Open network status</button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Error state</p>
            <h2>Latest operator issues</h2>
          </div>
        </div>
        {diagnostics?.issues.length ? (
          <div className="stack">
            {diagnostics.issues.map((issue) => (
              <MiniStat
                key={issue.key}
                label={issue.key}
                value={`${issue.message}${issue.updated_at ? ` · ${formatRelative(issue.updated_at)}` : ''}`}
              />
            ))}
            <MiniStat label="Runtime version" value={`${status.version}${updateAvailable && status.latest_version ? ` → ${status.latest_version}` : ''}`} />
          </div>
        ) : (
          <div className="stack">
            <MiniStat label="Register" value="Clear" />
            <MiniStat label="Heartbeat" value="Clear" />
            <MiniStat label="Claim" value="Clear" />
            <MiniStat label="Payout" value="Clear" />
            <MiniStat label="Runtime version" value={`${status.version}${updateAvailable && status.latest_version ? ` → ${status.latest_version}` : ''}`} />
          </div>
        )}
      </section>

      {diagnostics ? (
        <section className="panel panel-span-2">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Structured checks</p>
              <h2>Runtime readiness breakdown</h2>
            </div>
          </div>
          <div className="runtime-checks">
            {diagnostics.runtime_checks.map((check) => (
              <CheckRow key={check.key} label={check.label} state={check.ready} detail={check.detail} />
            ))}
          </div>
          {diagnostics.recommendations.length ? (
            <div className="top-gap">
              <p className="eyebrow">Recommended actions</p>
              <ul className="bullet-list">
                {diagnostics.recommendations.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {diagnostics.status_tokens.length ? (
            <div className="top-gap">
              <p className="eyebrow">Health report tokens</p>
              <div className="token-wrap">
                {diagnostics.status_tokens.map((token) => (
                  <span key={token} className="status-pill status-pill--neutral">{token}</span>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="panel panel-span-2">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Log tail</p>
            <h2>Recent runtime events</h2>
          </div>
        </div>
        <pre className="log-shell">{logs.length ? logs.join('\n') : 'No logs collected yet.'}</pre>
      </section>
    </div>
  )
}

function normalizeMetrics(metrics: OperatorStatusResponse['metrics']) {
  return {
    timestamp_ms: metrics.timestamp_ms,
    cpu_util: metrics.cpu_util ?? metrics.CPUUtil,
    mem_util: metrics.mem_util ?? metrics.MemUtil,
    gpu_util: metrics.gpu_util ?? metrics.GPUUtil,
    power_watts: metrics.power_watts ?? metrics.PowerWatts,
    gpu_throttled: metrics.gpu_throttled ?? metrics.GPUThrottled,
  }
}

function SettingsView({
  theme,
  localApiUrl,
  hubUrl,
  declaredCountry,
  runtimeProbe,
  onThemeChange,
  onLocalApiUrlChange,
  onHubUrlChange,
  onOpenExternal,
}: {
  theme: ThemeMode
  localApiUrl: string
  hubUrl: string
  declaredCountry?: string
  runtimeProbe: LocalRuntimeProbeResponse | null
  onThemeChange: (theme: ThemeMode) => void
  onLocalApiUrlChange: (value: string) => void
  onHubUrlChange: (value: string) => void
  onOpenExternal: (url: string) => void
}) {
  return (
    <div className="view-grid">
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Appearance</p>
            <h2>Theme and shell</h2>
          </div>
        </div>
        <div className="segmented-control">
          {(['system', 'light', 'dark'] as ThemeMode[]).map((value) => (
            <button key={value} className={theme === value ? 'segment is-active' : 'segment'} onClick={() => onThemeChange(value)}>
              {value}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Runtime targets</p>
            <h2>Connection endpoints</h2>
          </div>
        </div>
        <label>
          <span>Local API URL</span>
          <input value={localApiUrl} onChange={(event) => onLocalApiUrlChange(event.target.value)} />
        </label>
        {runtimeProbe ? (
          <div className="inline-actions">
            <button
              className="ghost-button"
              onClick={() => onLocalApiUrlChange(runtimeProbe.configured_api_url || runtimeProbe.suggested_api_url)}
            >
              Use detected runtime API
            </button>
            <p className="support-copy">Detected endpoint: {runtimeProbe.configured_api_url || runtimeProbe.suggested_api_url}</p>
          </div>
        ) : null}
        <label>
          <span>Hub URL</span>
          <input value={hubUrl} onChange={(event) => onHubUrlChange(event.target.value)} />
        </label>
        <p className="support-copy">Declared country from the node: {declaredCountry || 'Not declared'}</p>
      </section>

      <section className="panel panel-span-2">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Operator resources</p>
            <h2>Reference surfaces</h2>
          </div>
        </div>
        <div className="inline-actions">
          <button className="ghost-button" onClick={() => void onOpenExternal('https://ryvion.ai/operators')}>Operator guide</button>
          <button className="ghost-button" onClick={() => void onOpenExternal('https://ryvion.ai/docs#node-setup')}>Node setup docs</button>
          <button className="ghost-button" onClick={() => void onOpenExternal('https://ryvion.ai/status')}>Status & downloads</button>
        </div>
      </section>
    </div>
  )
}

function MetricCard({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <article className="metric-card">
      <p className="eyebrow">{title}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="mini-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function Notice({ children, tone }: { children: ReactNode; tone: 'good' | 'warn' | 'neutral' }) {
  return <div className={`notice notice--${tone}`}>{children}</div>
}

function StatusPill({ children, tone }: { children: string; tone: 'good' | 'warn' | 'neutral' }) {
  return <span className={`status-pill status-pill--${tone}`}>{children}</span>
}

function CheckRow({ label, state, detail }: { label: string; state: boolean; detail?: string }) {
  return (
    <div className="check-row">
      <div>
        <strong>{label}</strong>
        {detail ? <p>{detail}</p> : null}
      </div>
      <StatusPill tone={state ? 'good' : 'neutral'}>{state ? 'Ready' : 'Waiting'}</StatusPill>
    </div>
  )
}

function LoadRow({ label, value, text }: { label: string; value: number; text?: string }) {
  return (
    <div className="load-row">
      <div className="load-header">
        <strong>{label}</strong>
        <span>{text || formatPercent(value)}</span>
      </div>
      <div className="load-track">
        <div className="load-fill" style={{ width: `${Math.max(4, Math.min(100, value))}%` }} />
      </div>
    </div>
  )
}

function ThemeToggle({ value, onChange }: { value: ThemeMode; onChange: (theme: ThemeMode) => void }) {
  return (
    <label className="theme-toggle">
      <span>Theme</span>
      <select value={value} onChange={(event) => onChange(event.target.value as ThemeMode)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  )
}

function stringsPresent(value?: string | null) {
  return Boolean(value && value.trim())
}

function bytesToGB(value?: number | null) {
  if (!value || value <= 0) return 0
  return value / (1024 ** 3)
}

export default App
