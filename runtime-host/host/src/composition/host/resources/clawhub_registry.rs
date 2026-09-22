use openclaw::lifecycle::state_dir::CanonicalStateDir;

pub(in crate::composition::host) fn provision_clawhub_registry(
    diagnostics_state_root: &CanonicalStateDir,
) -> clawhub::ClawHubRegistryClient {
    clawhub::ClawHubRegistryClient::new(diagnostics_state_root.as_path().to_owned())
}
