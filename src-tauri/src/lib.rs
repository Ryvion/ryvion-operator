use serde::Serialize;
use std::env;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

#[derive(Serialize)]
struct LocalRuntimeProbe {
    platform: String,
    api_url: String,
    api_host: String,
    api_port: u16,
    api_port_open: bool,
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

#[cfg(target_os = "macos")]
fn probe_macos(api_url: String, host: String, port: u16, api_port_open: bool) -> LocalRuntimeProbe {
    let home = env::var("HOME").unwrap_or_default();
    let plist = PathBuf::from(&home).join("Library/LaunchAgents/com.ryvion.node.plist");
    let log_path = PathBuf::from(&home).join(".ryvion/node.log");
    let plist_contents = std::fs::read_to_string(&plist).unwrap_or_default();
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
    let service_configured_for_api = plist_contents.contains("<string>-ui-port</string>")
        || plist_contents.contains("<key>RYV_UI_PORT</key>");

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

    LocalRuntimeProbe {
        platform: "macos".to_string(),
        api_url,
        api_host: host,
        api_port: port,
        api_port_open,
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
    let mut binary_candidates = vec![
        "/opt/ryvion/ryvion-node".to_string(),
        "/usr/local/bin/ryvion-node".to_string(),
    ];
    if let Some(path) = extract_systemd_exec_start(&unit_text) {
        binary_candidates.insert(0, path);
    }
    let binary_paths = existing_paths(binary_candidates);
    let binary_supports_local_api = binary_paths
        .iter()
        .any(|path| binary_help_contains(path, "-ui-port"));
    let service_configured_for_api = unit_text.contains("Environment=RYV_UI_PORT=") || unit_text.contains("-ui-port");

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

    LocalRuntimeProbe {
        platform: "linux".to_string(),
        api_url,
        api_host: host,
        api_port: port,
        api_port_open,
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
    let service_configured_for_api = service_config.contains("-ui-port") || env::var("RYV_UI_PORT").is_ok();
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

    LocalRuntimeProbe {
        platform: "windows".to_string(),
        api_url,
        api_host: host,
        api_port: port,
        api_port_open,
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

#[cfg(target_os = "macos")]
fn escape_applescript(input: &str) -> String {
    input.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn extract_plist_program_path(contents: &str) -> Option<String> {
    let marker = "<key>ProgramArguments</key>";
    let start = contents.find(marker)?;
    let rest = &contents[start + marker.len()..];
    let value_start = rest.find("<string>")?;
    let value_end = rest[value_start + 8..].find("</string>")?;
    Some(rest[value_start + 8..value_start + 8 + value_end].trim().to_string())
}

#[cfg(target_os = "linux")]
fn extract_systemd_exec_start(contents: &str) -> Option<String> {
    contents
        .lines()
        .find_map(|line| line.trim().strip_prefix("ExecStart=").map(|value| value.trim().to_string()))
        .and_then(|value| value.split_whitespace().next().map(|token| token.to_string()))
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
        .invoke_handler(tauri::generate_handler![probe_local_runtime, run_local_runtime_action])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
