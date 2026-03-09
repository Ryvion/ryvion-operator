use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::Value;
use std::env;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

const DEFAULT_LOCAL_API_URL: &str = "http://127.0.0.1:45890";

#[derive(Clone, Serialize)]
struct LocalRuntimeProbe {
    platform: String,
    api_url: String,
    api_host: String,
    api_port: u16,
    api_port_open: bool,
    configured_api_url: Option<String>,
    configured_api_port_open: bool,
    api_url_mismatch: bool,
    suggested_api_url: String,
    service_installed: bool,
    service_running: bool,
    service_configured_for_api: bool,
    binary_supports_local_api: bool,
    binary_paths: Vec<String>,
    log_path: Option<String>,
    install_command: String,
    start_command: Option<String>,
    log_command: Option<String>,
    notes: Vec<String>,
}

#[derive(Serialize)]
struct RuntimeActionResult {
    launched: bool,
    message: String,
}

#[derive(Serialize)]
struct LocalRuntimeAttempt {
    api_url: String,
    ok: bool,
    error: Option<String>,
}

#[derive(Serialize)]
struct LocalRuntimeSnapshot {
    ok: bool,
    api_url: Option<String>,
    recovered: bool,
    probe: LocalRuntimeProbe,
    attempts: Vec<LocalRuntimeAttempt>,
    status: Option<Value>,
    jobs: Option<Value>,
    logs: Option<Value>,
    diagnostics: Option<Value>,
    error: Option<String>,
}

#[tauri::command]
fn probe_local_runtime(api_url: String) -> LocalRuntimeProbe {
    let (host, port) = parse_host_port(&api_url).unwrap_or_else(|| ("127.0.0.1".to_string(), 45890));
    let api_port_open = tcp_open(&host, port);

    #[cfg(target_os = "macos")]
    {
        return probe_macos(api_url, host, port, api_port_open);
    }
    #[cfg(target_os = "linux")]
    {
        return probe_linux(api_url, host, port, api_port_open);
    }
    #[cfg(target_os = "windows")]
    {
        return probe_windows(api_url, host, port, api_port_open);
    }
    #[allow(unreachable_code)]
    LocalRuntimeProbe {
        platform: env::consts::OS.to_string(),
        api_url,
        api_host: host,
        api_port: port,
        api_port_open,
        configured_api_url: None,
        configured_api_port_open: api_port_open,
        api_url_mismatch: false,
        suggested_api_url: format!("http://127.0.0.1:{port}"),
        service_installed: false,
        service_running: false,
        service_configured_for_api: false,
        binary_supports_local_api: false,
        binary_paths: Vec::new(),
        log_path: None,
        install_command: "Use the operator guide to install the node runtime.".to_string(),
        start_command: None,
        log_command: None,
        notes: vec!["Runtime probe is not implemented for this platform.".to_string()],
    }
}

#[tauri::command]
fn run_local_runtime_action(action: String, api_url: String, hub_url: Option<String>) -> Result<RuntimeActionResult, String> {
    #[cfg(target_os = "macos")]
    {
        return run_macos_runtime_action(&action, &api_url, hub_url.as_deref());
    }
    #[cfg(target_os = "linux")]
    {
        return run_linux_runtime_action(&action, &api_url, hub_url.as_deref());
    }
    #[cfg(target_os = "windows")]
    {
        return run_windows_runtime_action(&action, hub_url.as_deref());
    }
    #[allow(unreachable_code)]
    Err(format!("runtime action '{}' is not supported on {}", action, env::consts::OS))
}

#[tauri::command]
fn load_local_runtime_snapshot(api_url: String) -> LocalRuntimeSnapshot {
    let probe = probe_local_runtime(api_url.clone());
    let candidates = candidate_api_urls(&api_url, &probe);
    let client = match Client::builder().timeout(Duration::from_secs(4)).build() {
        Ok(client) => client,
        Err(err) => {
            return LocalRuntimeSnapshot {
                ok: false,
                api_url: None,
                recovered: false,
                probe,
                attempts: Vec::new(),
                status: None,
                jobs: None,
                logs: None,
                diagnostics: None,
                error: Some(format!("Failed to initialize local runtime client: {err}")),
            }
        }
    };

    let mut attempts = Vec::new();
    let mut last_error = String::new();
    for candidate in candidates {
        match fetch_runtime_snapshot_for_candidate(&client, &candidate) {
            Ok((status, jobs, logs, diagnostics)) => {
                let recovered = normalize_api_url(&candidate) != normalize_api_url(&api_url);
                attempts.push(LocalRuntimeAttempt {
                    api_url: candidate.clone(),
                    ok: true,
                    error: None,
                });
                return LocalRuntimeSnapshot {
                    ok: true,
                    api_url: Some(candidate),
                    recovered,
                    probe,
                    attempts,
                    status: Some(status),
                    jobs: Some(jobs),
                    logs: Some(logs),
                    diagnostics,
                    error: None,
                };
            }
            Err(err) => {
                last_error = err.clone();
                attempts.push(LocalRuntimeAttempt {
                    api_url: candidate,
                    ok: false,
                    error: Some(err),
                });
            }
        }
    }

    LocalRuntimeSnapshot {
        ok: false,
        api_url: None,
        recovered: false,
        probe,
        attempts,
        status: None,
        jobs: None,
        logs: None,
        diagnostics: None,
        error: Some(last_error_or_default(&last_error, "Unable to reach the local operator API.")),
    }
}

#[cfg(target_os = "macos")]
fn probe_macos(api_url: String, host: String, port: u16, api_port_open: bool) -> LocalRuntimeProbe {
    let home = env::var("HOME").unwrap_or_default();
    let plist = PathBuf::from(&home).join("Library/LaunchAgents/com.ryvion.node.plist");
    let log_path = PathBuf::from(&home).join(".ryvion/node.log");
    let plist_contents = std::fs::read_to_string(&plist).unwrap_or_default();
    let plist_args = extract_plist_program_arguments(&plist_contents);
    let mut binary_candidates = vec![
        "/usr/local/bin/ryvion-node".to_string(),
        "/opt/homebrew/bin/ryvion-node".to_string(),
    ];
    if let Some(path) = extract_plist_program_path(&plist_contents) {
        binary_candidates.insert(0, path);
    }
    let installed = plist.exists() || binary_candidates.iter().any(|path| PathBuf::from(path).exists());
    let listed = command_output("launchctl", &["list"]).contains("com.ryvion.node");
    let service_running = listed;
    let uid = command_output("id", &["-u"]);
    let binary_paths = existing_paths(binary_candidates);
    let binary_supports_local_api = binary_paths
        .iter()
        .any(|path| binary_help_contains(path, "-ui-port"));
    let configured_port = extract_plist_ui_port(&plist_contents)
        .or_else(|| find_flag_value_in_tokens(&plist_args, "-ui-port").and_then(|value| value.parse::<u16>().ok()));
    let configured_api_url = configured_port.map(loopback_api_url);
    let configured_api_port_open = configured_port
        .map(|configured| tcp_open("127.0.0.1", configured))
        .unwrap_or(api_port_open);
    let service_configured_for_api = configured_port.is_some();
    let api_url_mismatch = configured_api_url
        .as_ref()
        .map(|configured| normalize_api_url(configured) != normalize_api_url(&api_url))
        .unwrap_or(false);
    let suggested_api_url = configured_api_url.clone().unwrap_or_else(|| loopback_api_url(port));

    let mut notes = Vec::new();
    if !installed {
        notes.push("Ryvion node runtime does not appear to be installed for this user.".to_string());
    }
    if installed && !service_running {
        notes.push("The launch agent exists but does not appear to be loaded in the current login session.".to_string());
    }
    if service_running && !service_configured_for_api {
        notes.push("The launch agent is using an older service definition that does not enable the local operator API.".to_string());
    }
    if installed && !binary_supports_local_api {
        notes.push("The installed ryvion-node binary predates local operator API support. Reinstall or update the node runtime.".to_string());
    }
    if service_running && !api_port_open {
        notes.push("The launch agent appears loaded, but the local operator API port is not listening yet.".to_string());
    }
    if api_url_mismatch {
        notes.push(format!(
            "The saved operator API URL does not match the endpoint configured in the launch agent. Use {} instead.",
            suggested_api_url
        ));
    }

    LocalRuntimeProbe {
        platform: "macos".to_string(),
        api_url,
        api_host: host,
        api_port: port,
        api_port_open,
        configured_api_url,
        configured_api_port_open,
        api_url_mismatch,
        suggested_api_url,
        service_installed: installed,
        service_running,
        service_configured_for_api,
        binary_supports_local_api,
        binary_paths,
        log_path: Some(log_path.display().to_string()),
        install_command: "curl -sSL https://ryvion-hub.fly.dev/install.sh?platform=macos | bash".to_string(),
        start_command: Some(format!("launchctl kickstart -k gui/{}/com.ryvion.node", uid.trim())),
        log_command: Some("tail -f ~/.ryvion/node.log".to_string()),
        notes,
    }
}

#[cfg(target_os = "macos")]
fn run_macos_runtime_action(action: &str, api_url: &str, hub_url: Option<&str>) -> Result<RuntimeActionResult, String> {
    let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let plist = PathBuf::from(&home).join("Library/LaunchAgents/com.ryvion.node.plist");
    let uid = command_output("id", &["-u"]);
    let service_label = format!("gui/{}/com.ryvion.node", uid.trim());

    match action {
        "restart" => {
            if !plist.exists() {
                return Err("Launch agent is not installed yet. Run the repair installer first.".to_string());
            }
            let plist_string = plist.display().to_string();
            let bootstrap = Command::new("launchctl")
                .args(["bootstrap", &format!("gui/{}", uid.trim()), &plist_string])
                .status();
            if let Ok(status) = bootstrap {
                if !status.success() {
                    let _ = Command::new("launchctl").args(["load", &plist_string]).status();
                }
            }
            let status = Command::new("launchctl")
                .args(["kickstart", "-k", &service_label])
                .status()
                .map_err(|err| format!("Failed to restart launch agent: {err}"))?;
            if !status.success() {
                return Err("launchctl did not restart the Ryvion node service.".to_string());
            }
            let (_, port) = parse_host_port(api_url).unwrap_or_else(|| ("127.0.0.1".to_string(), 45890));
            return Ok(RuntimeActionResult {
                launched: true,
                message: format!("Requested launchctl restart. Re-check http://127.0.0.1:{port}/healthz in a few seconds."),
            });
        }
        "repair" => {
            let hub = hub_url.filter(|v| !v.trim().is_empty()).unwrap_or("https://ryvion-hub.fly.dev");
            let script = format!("curl -sSL '{}/install.sh?platform=macos' | bash", hub.trim_end_matches('/'));
            let apple_script = format!(
                "tell application \"Terminal\" to do script \"{}\"\nactivate application \"Terminal\"",
                escape_applescript(&script)
            );
            let status = Command::new("osascript")
                .arg("-e")
                .arg(apple_script)
                .status()
                .map_err(|err| format!("Failed to launch Terminal repair flow: {err}"))?;
            if !status.success() {
                return Err("Terminal did not start the repair installer.".to_string());
            }
            return Ok(RuntimeActionResult {
                launched: true,
                message: "Opened Terminal with the Ryvion macOS installer. Follow any password prompts, then refresh the app.".to_string(),
            });
        }
        _ => Err(format!("Unsupported runtime action: {action}")),
    }
}

#[cfg(target_os = "linux")]
fn probe_linux(api_url: String, host: String, port: u16, api_port_open: bool) -> LocalRuntimeProbe {
    let home = env::var("HOME").unwrap_or_default();
    let log_path = PathBuf::from(&home).join(".ryvion/node.log");
    let service_installed = command_success("systemctl", &["status", "ryvion-node"]);
    let service_running = command_success("systemctl", &["is-active", "--quiet", "ryvion-node"]);
    let unit_text = command_output("systemctl", &["cat", "ryvion-node"]);
    let exec_start = extract_systemd_exec_start_command(&unit_text);
    let mut binary_candidates = vec![
        "/opt/ryvion/ryvion-node".to_string(),
        "/usr/local/bin/ryvion-node".to_string(),
    ];
    if let Some(path) = extract_systemd_exec_start_path(&unit_text) {
        binary_candidates.insert(0, path);
    }
    let binary_paths = existing_paths(binary_candidates);
    let binary_supports_local_api = binary_paths
        .iter()
        .any(|path| binary_help_contains(path, "-ui-port"));
    let configured_port = extract_systemd_ui_port(&unit_text).or_else(|| {
        exec_start
            .as_deref()
            .map(split_command_tokens)
            .as_ref()
            .and_then(|tokens| find_flag_value_in_tokens(tokens, "-ui-port"))
            .and_then(|value| value.parse::<u16>().ok())
    });
    let configured_api_url = configured_port.map(loopback_api_url);
    let configured_api_port_open = configured_port
        .map(|configured| tcp_open("127.0.0.1", configured))
        .unwrap_or(api_port_open);
    let service_configured_for_api = configured_port.is_some();
    let api_url_mismatch = configured_api_url
        .as_ref()
        .map(|configured| normalize_api_url(configured) != normalize_api_url(&api_url))
        .unwrap_or(false);
    let suggested_api_url = configured_api_url.clone().unwrap_or_else(|| loopback_api_url(port));

    let mut notes = Vec::new();
    if !service_installed {
        notes.push("systemd does not report a ryvion-node service on this host.".to_string());
    }
    if service_installed && !service_running {
        notes.push("The ryvion-node service exists but is not active.".to_string());
    }
    if service_running && !service_configured_for_api {
        notes.push("The systemd unit is using an older service definition that does not enable the local operator API.".to_string());
    }
    if service_installed && !binary_supports_local_api {
        notes.push("The installed ryvion-node binary predates local operator API support. Reinstall or update the node runtime.".to_string());
    }
    if service_running && !api_port_open {
        notes.push("The service is active, but the local operator API port is not reachable.".to_string());
    }
    if api_url_mismatch {
        notes.push(format!(
            "The saved operator API URL does not match the endpoint configured in systemd. Use {} instead.",
            suggested_api_url
        ));
    }

    LocalRuntimeProbe {
        platform: "linux".to_string(),
        api_url,
        api_host: host,
        api_port: port,
        api_port_open,
        configured_api_url,
        configured_api_port_open,
        api_url_mismatch,
        suggested_api_url,
        service_installed,
        service_running,
        service_configured_for_api,
        binary_supports_local_api,
        binary_paths,
        log_path: Some(log_path.display().to_string()),
        install_command: "curl -sSL https://ryvion-hub.fly.dev/install.sh | bash".to_string(),
        start_command: Some("sudo systemctl restart ryvion-node".to_string()),
        log_command: Some("journalctl -u ryvion-node -f".to_string()),
        notes,
    }
}

#[cfg(target_os = "linux")]
fn run_linux_runtime_action(action: &str, api_url: &str, hub_url: Option<&str>) -> Result<RuntimeActionResult, String> {
    let (_, port) = parse_host_port(api_url).unwrap_or_else(|| ("127.0.0.1".to_string(), 45890));
    let command = match action {
        "restart" => format!("sudo systemctl restart ryvion-node; echo; curl -fsS http://127.0.0.1:{port}/healthz || true; echo; read -n 1 -s -r -p 'Press any key to close'"),
        "repair" => {
            let hub = hub_url.filter(|v| !v.trim().is_empty()).unwrap_or("https://ryvion-hub.fly.dev");
            format!("curl -sSL '{}/install.sh' | bash; echo; read -n 1 -s -r -p 'Press any key to close'", hub.trim_end_matches('/'))
        }
        _ => return Err(format!("Unsupported runtime action: {action}")),
    };
    launch_linux_terminal(&command)?;
    Ok(RuntimeActionResult {
        launched: true,
        message: "Opened a terminal to run the requested runtime action.".to_string(),
    })
}

#[cfg(target_os = "windows")]
fn probe_windows(api_url: String, host: String, port: u16, api_port_open: bool) -> LocalRuntimeProbe {
    let program_files = env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
    let binary_candidates = vec![format!("{}\\Ryvion\\ryvion-node.exe", program_files)];
    let service_query = command_output("sc.exe", &["query", "RyvionNode"]);
    let service_config = command_output("sc.exe", &["qc", "RyvionNode"]);
    let service_installed = service_query.contains("SERVICE_NAME: RyvionNode");
    let service_running = service_query.contains("RUNNING");
    let binary_paths = existing_paths(binary_candidates);
    let binary_supports_local_api = binary_paths
        .iter()
        .any(|path| binary_help_contains(path, "-ui-port"));
    let configured_port = extract_windows_service_ui_port(&service_config)
        .or_else(|| env::var("RYV_UI_PORT").ok().and_then(|value| value.trim().parse::<u16>().ok()));
    let configured_api_url = configured_port.map(loopback_api_url);
    let configured_api_port_open = configured_port
        .map(|configured| tcp_open("127.0.0.1", configured))
        .unwrap_or(api_port_open);
    let service_configured_for_api = configured_port.is_some();
    let api_url_mismatch = configured_api_url
        .as_ref()
        .map(|configured| normalize_api_url(configured) != normalize_api_url(&api_url))
        .unwrap_or(false);
    let suggested_api_url = configured_api_url.clone().unwrap_or_else(|| loopback_api_url(port));
    let log_path = env::var("USERPROFILE").ok().map(|v| format!("{}\\.ryvion\\node.log", v));

    let mut notes = Vec::new();
    if !service_installed {
        notes.push("Windows service RyvionNode is not installed.".to_string());
    }
    if service_installed && !service_running {
        notes.push("RyvionNode service exists but is not running.".to_string());
    }
    if service_running && !service_configured_for_api {
        notes.push("The Windows service is using an older definition that does not enable the local operator API.".to_string());
    }
    if service_installed && !binary_supports_local_api {
        notes.push("The installed ryvion-node binary predates local operator API support. Reinstall or update the node runtime.".to_string());
    }
    if service_running && !api_port_open {
        notes.push("The Windows service is running, but the local operator API port is not reachable.".to_string());
    }
    if api_url_mismatch {
        notes.push(format!(
            "The saved operator API URL does not match the endpoint configured in the Windows service. Use {} instead.",
            suggested_api_url
        ));
    }

    LocalRuntimeProbe {
        platform: "windows".to_string(),
        api_url,
        api_host: host,
        api_port: port,
        api_port_open,
        configured_api_url,
        configured_api_port_open,
        api_url_mismatch,
        suggested_api_url,
        service_installed,
        service_running,
        service_configured_for_api,
        binary_supports_local_api,
        binary_paths,
        log_path,
        install_command: "iex ((New-Object System.Net.WebClient).DownloadString('https://ryvion-hub.fly.dev/install.ps1'))".to_string(),
        start_command: Some("Start-Service RyvionNode".to_string()),
        log_command: Some("Get-Content $env:USERPROFILE\\.ryvion\\node.log -Wait".to_string()),
        notes,
    }
}

#[cfg(target_os = "windows")]
fn run_windows_runtime_action(action: &str, hub_url: Option<&str>) -> Result<RuntimeActionResult, String> {
    let command = match action {
        "restart" => "Start-Service RyvionNode".to_string(),
        "repair" => {
            let hub = hub_url.filter(|v| !v.trim().is_empty()).unwrap_or("https://ryvion-hub.fly.dev");
            format!("iex ((New-Object System.Net.WebClient).DownloadString('{}/install.ps1'))", hub.trim_end_matches('/'))
        }
        _ => return Err(format!("Unsupported runtime action: {action}")),
    };
    let powershell_args = format!(
        "Start-Process PowerShell -Verb RunAs -ArgumentList '-NoExit','-ExecutionPolicy','Bypass','-Command',\"{}\"",
        command.replace('"', "\\\"")
    );
    let status = Command::new("powershell")
        .args(["-NoProfile", "-Command", powershell_args.as_str()])
        .status()
        .map_err(|err| format!("Failed to launch PowerShell repair flow: {err}"))?;
    if !status.success() {
        return Err("PowerShell did not start the requested runtime action.".to_string());
    }
    Ok(RuntimeActionResult {
        launched: true,
        message: "Opened an elevated PowerShell window to run the requested runtime action.".to_string(),
    })
}

fn candidate_api_urls(requested: &str, probe: &LocalRuntimeProbe) -> Vec<String> {
    let mut candidates = Vec::new();
    for value in [
        Some(requested.to_string()),
        probe.configured_api_url.clone(),
        Some(probe.suggested_api_url.clone()),
        Some(DEFAULT_LOCAL_API_URL.to_string()),
    ]
    .into_iter()
    .flatten()
    {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        if candidates
            .iter()
            .any(|existing: &String| normalize_api_url(existing) == normalize_api_url(trimmed))
        {
            continue;
        }
        candidates.push(trimmed.to_string());
    }
    candidates
}

fn fetch_runtime_snapshot_for_candidate(
    client: &Client,
    base_url: &str,
) -> Result<(Value, Value, Value, Option<Value>), String> {
    let status = fetch_required_json(client, base_url, "/api/v1/operator/status")?;
    let jobs = fetch_optional_json(client, base_url, "/api/v1/operator/jobs")
        .unwrap_or_else(|| serde_json::json!({ "jobs": [] }));
    let logs = fetch_optional_json(client, base_url, "/api/v1/operator/logs?limit=200")
        .unwrap_or_else(|| serde_json::json!({ "lines": [] }));
    let diagnostics = fetch_optional_json(client, base_url, "/api/v1/operator/diagnostics");
    Ok((status, jobs, logs, diagnostics))
}

fn fetch_required_json(client: &Client, base_url: &str, path: &str) -> Result<Value, String> {
    let url = format!("{}{}", normalize_http_base(base_url), path);
    let response = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .map_err(|err| format!("{}: {}", url, err))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(format!("{}: {} {}", url, status.as_u16(), body.trim()));
    }
    response
        .json::<Value>()
        .map_err(|err| format!("{}: invalid JSON response ({})", url, err))
}

fn fetch_optional_json(client: &Client, base_url: &str, path: &str) -> Option<Value> {
    fetch_required_json(client, base_url, path).ok()
}

fn normalize_http_base(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn last_error_or_default(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn parse_host_port(api_url: &str) -> Option<(String, u16)> {
    let trimmed = api_url.trim();
    let without_scheme = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
        .unwrap_or(trimmed);
    let host_port = without_scheme.split('/').next()?.trim();
    if host_port.is_empty() {
        return None;
    }
    let mut parts = host_port.rsplitn(2, ':');
    let port = parts.next()?.parse::<u16>().ok()?;
    let host = parts.next().unwrap_or("127.0.0.1").trim().to_string();
    Some((host, port))
}

fn loopback_api_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn normalize_api_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn tcp_open(host: &str, port: u16) -> bool {
    let address = format!("{}:{}", host, port);
    match address.to_socket_addrs() {
        Ok(mut addrs) => addrs.any(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()),
        Err(_) => false,
    }
}

fn command_output(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd)
        .args(args)
        .output()
        .map(|output| {
            let mut text = String::new();
            text.push_str(&String::from_utf8_lossy(&output.stdout));
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            text
        })
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn command_success(cmd: &str, args: &[&str]) -> bool {
    Command::new(cmd)
        .args(args)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn existing_paths(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|path| PathBuf::from(path).exists())
        .collect()
}

fn binary_help_contains(path: &str, needle: &str) -> bool {
    command_output(path, &["-h"]).contains(needle)
}

fn escape_applescript(input: &str) -> String {
    input.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows", test))]
fn find_flag_value_in_tokens(tokens: &[String], flag: &str) -> Option<String> {
    tokens
        .windows(2)
        .find(|pair| pair.first().map(|token| token.as_str()) == Some(flag))
        .and_then(|pair| pair.get(1).cloned())
}

#[cfg(any(target_os = "linux", target_os = "windows", test))]
fn split_command_tokens(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for ch in input.chars() {
        match ch {
            '"' | '\'' => {
                if quote == Some(ch) {
                    quote = None;
                } else if quote.is_none() {
                    quote = Some(ch);
                } else {
                    current.push(ch);
                }
            }
            ch if ch.is_whitespace() && quote.is_none() => {
                if !current.is_empty() {
                    tokens.push(current.trim().to_string());
                    current.clear();
                }
            }
            _ => current.push(ch),
        }
    }

    if !current.trim().is_empty() {
        tokens.push(current.trim().to_string());
    }
    tokens
}

#[cfg(any(target_os = "macos", test))]
fn extract_plist_program_path(contents: &str) -> Option<String> {
    let marker = "<key>ProgramArguments</key>";
    let start = contents.find(marker)?;
    let rest = &contents[start + marker.len()..];
    let value_start = rest.find("<string>")?;
    let value_end = rest[value_start + 8..].find("</string>")?;
    Some(rest[value_start + 8..value_start + 8 + value_end].trim().to_string())
}

#[cfg(any(target_os = "macos", test))]
fn extract_plist_program_arguments(contents: &str) -> Vec<String> {
    let marker = "<key>ProgramArguments</key>";
    let Some(start) = contents.find(marker) else {
        return Vec::new();
    };
    let rest = &contents[start + marker.len()..];
    let Some(array_start) = rest.find("<array>") else {
        return Vec::new();
    };
    let after_array = &rest[array_start + "<array>".len()..];
    let Some(array_end) = after_array.find("</array>") else {
        return Vec::new();
    };
    let block = &after_array[..array_end];
    let mut values = Vec::new();
    let mut cursor = block;
    while let Some(value_start) = cursor.find("<string>") {
        let tail = &cursor[value_start + "<string>".len()..];
        let Some(value_end) = tail.find("</string>") else {
            break;
        };
        values.push(tail[..value_end].trim().to_string());
        cursor = &tail[value_end + "</string>".len()..];
    }
    values
}

#[cfg(any(target_os = "macos", test))]
fn extract_plist_ui_port(contents: &str) -> Option<u16> {
    if let Some(index) = contents.find("<key>RYV_UI_PORT</key>") {
        let tail = &contents[index + "<key>RYV_UI_PORT</key>".len()..];
        if let Some(value_start) = tail.find("<string>") {
            let tail = &tail[value_start + "<string>".len()..];
            if let Some(value_end) = tail.find("</string>") {
                if let Ok(port) = tail[..value_end].trim().parse::<u16>() {
                    return Some(port);
                }
            }
        }
    }
    let args = extract_plist_program_arguments(contents);
    find_flag_value_in_tokens(&args, "-ui-port").and_then(|value| value.parse::<u16>().ok())
}

#[cfg(any(target_os = "linux", test))]
fn extract_systemd_exec_start_command(contents: &str) -> Option<String> {
    contents
        .lines()
        .find_map(|line| line.trim().strip_prefix("ExecStart=").map(|value| value.trim().to_string()))
}

#[cfg(any(target_os = "linux", test))]
fn extract_systemd_exec_start_path(contents: &str) -> Option<String> {
    extract_systemd_exec_start_command(contents)
        .map(|value| split_command_tokens(&value))
        .and_then(|tokens| tokens.first().cloned())
}

#[cfg(any(target_os = "linux", test))]
fn extract_systemd_ui_port(contents: &str) -> Option<u16> {
    for line in contents.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("Environment=RYV_UI_PORT=") {
            if let Ok(port) = value.trim_matches('"').trim().parse::<u16>() {
                return Some(port);
            }
        }
    }
    extract_systemd_exec_start_command(contents)
        .map(|value| split_command_tokens(&value))
        .as_ref()
        .and_then(|tokens| find_flag_value_in_tokens(tokens, "-ui-port"))
        .and_then(|value| value.parse::<u16>().ok())
}

#[cfg(any(target_os = "windows", test))]
fn extract_windows_service_ui_port(contents: &str) -> Option<u16> {
    contents
        .lines()
        .find(|line| line.contains("BINARY_PATH_NAME"))
        .and_then(|line| line.split_once(':').map(|(_, value)| value.trim().to_string()))
        .map(|value| split_command_tokens(&value))
        .as_ref()
        .and_then(|tokens| find_flag_value_in_tokens(tokens, "-ui-port"))
        .and_then(|value| value.parse::<u16>().ok())
}

#[cfg(target_os = "linux")]
fn launch_linux_terminal(command: &str) -> Result<(), String> {
    let candidates: [(&str, &[&str]); 5] = [
        ("x-terminal-emulator", &["-e", "bash", "-lc"]),
        ("gnome-terminal", &["--", "bash", "-lc"]),
        ("konsole", &["-e", "bash", "-lc"]),
        ("alacritty", &["-e", "bash", "-lc"]),
        ("kitty", &["bash", "-lc"]),
    ];
    for (program, prefix) in candidates {
        let mut cmd = Command::new(program);
        cmd.args(prefix).arg(command);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }
    Err("Could not find a supported terminal emulator. Copy the command from diagnostics and run it manually.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            probe_local_runtime,
            load_local_runtime_snapshot,
            run_local_runtime_action
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn parses_plist_ui_port_from_environment() {
        let plist = r#"
        <plist>
          <dict>
            <key>EnvironmentVariables</key>
            <dict>
              <key>RYV_UI_PORT</key>
              <string>45890</string>
            </dict>
            <key>ProgramArguments</key>
            <array>
              <string>/usr/local/bin/ryvion-node</string>
              <string>-hub</string>
              <string>https://ryvion-hub.fly.dev</string>
            </array>
          </dict>
        </plist>
        "#;
        assert_eq!(extract_plist_ui_port(plist), Some(45890));
    }

    #[test]
    fn parses_plist_ui_port_from_program_arguments() {
        let plist = r#"
        <plist>
          <dict>
            <key>ProgramArguments</key>
            <array>
              <string>/usr/local/bin/ryvion-node</string>
              <string>-hub</string>
              <string>https://ryvion-hub.fly.dev</string>
              <string>-ui-port</string>
              <string>45901</string>
            </array>
          </dict>
        </plist>
        "#;
        assert_eq!(extract_plist_ui_port(plist), Some(45901));
    }

    #[test]
    fn parses_systemd_ui_port() {
        let unit = r#"
        [Service]
        ExecStart=/opt/ryvion/ryvion-node -hub https://ryvion-hub.fly.dev -ui-port 45910
        Environment=RYV_UI_PORT=45910
        "#;
        assert_eq!(extract_systemd_ui_port(unit), Some(45910));
    }

    #[test]
    fn parses_systemd_exec_start_path() {
        let unit = r#"
        [Service]
        ExecStart="/opt/ryvion/ryvion-node" -hub https://ryvion-hub.fly.dev -ui-port 45910
        "#;
        assert_eq!(
            extract_systemd_exec_start_path(unit),
            Some("/opt/ryvion/ryvion-node".to_string())
        );
    }

    #[test]
    fn parses_windows_service_ui_port() {
        let config = r#"
SERVICE_NAME: RyvionNode
        BINARY_PATH_NAME   : "C:\Program Files\Ryvion\ryvion-node.exe" -hub https://ryvion-hub.fly.dev -ui-port 45920
        "#;
        assert_eq!(extract_windows_service_ui_port(config), Some(45920));
    }

    #[test]
    fn splits_quoted_command_tokens() {
        let tokens = split_command_tokens(r#""C:\Program Files\Ryvion\ryvion-node.exe" -ui-port 45890"#);
        assert_eq!(tokens, vec![r#"C:\Program Files\Ryvion\ryvion-node.exe"#, "-ui-port", "45890"]);
    }

    #[test]
    fn candidate_api_urls_are_deduplicated_and_ordered() {
        let probe = LocalRuntimeProbe {
            platform: "macos".to_string(),
            api_url: "http://127.0.0.1:45891".to_string(),
            api_host: "127.0.0.1".to_string(),
            api_port: 45891,
            api_port_open: false,
            configured_api_url: Some("http://127.0.0.1:45890".to_string()),
            configured_api_port_open: true,
            api_url_mismatch: true,
            suggested_api_url: "http://127.0.0.1:45890".to_string(),
            service_installed: true,
            service_running: true,
            service_configured_for_api: true,
            binary_supports_local_api: true,
            binary_paths: vec!["/usr/local/bin/ryvion-node".to_string()],
            log_path: None,
            install_command: "install".to_string(),
            start_command: None,
            log_command: None,
            notes: Vec::new(),
        };

        let candidates = candidate_api_urls("http://127.0.0.1:45891", &probe);
        assert_eq!(
            candidates,
            vec![
                "http://127.0.0.1:45891".to_string(),
                "http://127.0.0.1:45890".to_string(),
            ]
        );
    }

    #[test]
    fn fetch_runtime_snapshot_reads_local_operator_endpoints() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let addr = listener.local_addr().expect("read listener addr");
        let server = thread::spawn(move || {
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().expect("accept connection");
                let mut buffer = [0u8; 2048];
                let bytes = stream.read(&mut buffer).expect("read request");
                let request = String::from_utf8_lossy(&buffer[..bytes]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                let (status, body) = match path {
                    "/api/v1/operator/status" => (
                        "200 OK",
                        r#"{"version":"v1.2.25","runtime":{"local_api_url":"http://127.0.0.1:45890"}}"#,
                    ),
                    "/api/v1/operator/jobs" => ("200 OK", r#"{"jobs":[{"job_id":"job_123","status":"done"}]}"#),
                    "/api/v1/operator/logs?limit=200" => ("200 OK", r#"{"lines":["ok"]}"#),
                    _ => ("404 Not Found", r#"{"error":"not_found"}"#),
                };
                let response = format!(
                    "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status,
                    body.len(),
                    body
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("write response");
            }
        });

        let client = Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .expect("build reqwest client");
        let base_url = format!("http://{}", addr);
        let (status, jobs, logs, diagnostics) =
            fetch_runtime_snapshot_for_candidate(&client, &base_url).expect("fetch runtime snapshot");

        assert_eq!(status["version"], "v1.2.25");
        assert_eq!(jobs["jobs"][0]["job_id"], "job_123");
        assert_eq!(logs["lines"][0], "ok");
        assert!(diagnostics.is_none());
        server.join().expect("join test server");
    }
}
