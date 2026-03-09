# Ryvion Operator

Ryvion Operator is the cross-platform desktop control plane for Windows, macOS, and Linux nodes.

It is designed for operators, not buyers.

## What it does

- Connects to the local `ryvion-node` operator API on `http://127.0.0.1:45890`
- Shows live machine posture: CPU, RAM, GPU, Docker, native inference state
- Tracks the current job, recent jobs, and local runtime logs
- Handles node claim flow with short claim codes
- Handles Stripe Connect payout onboarding and payout preference save
- Shows operator earnings and claimed-node stats after cloud sign-in

## Runtime requirements

- `node-agent` build with the local operator API enabled
- Local node service running on the same machine
- Hub access to `https://ryvion-hub.fly.dev` for cloud sign-in, claim-code generation, and operator stats

## Development

```bash
npm install
npm run dev
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri dev
```

## Local API contract

The app uses these local endpoints from `node-agent`:

- `GET /api/v1/operator/status`
- `GET /api/v1/operator/jobs`
- `GET /api/v1/operator/logs`
- `POST /api/v1/operator/claim`
- `POST /api/v1/operator/payout`
- `POST /api/v1/operator/connect/create`
- `POST /api/v1/operator/connect/onboarding-link`
- `GET /api/v1/operator/connect/status`

## Notes

- The desktop app keeps operator-specific UI separate from the public website.
- Sensitive buyer/admin flows are not embedded into the app.
- The node itself remains a headless service; the app is a local management surface.
