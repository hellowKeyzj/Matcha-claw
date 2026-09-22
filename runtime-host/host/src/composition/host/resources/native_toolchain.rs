use std::sync::Arc;

#[cfg(windows)]
pub(in crate::composition::host) fn provision_native_toolchain(
    open_claw: &openclaw::driver::OpenClawInput,
) -> Arc<::toolchain::NativeToolchain> {
    ::toolchain::NativeToolchain::local(open_claw.working_directory.clone())
}

#[cfg(unix)]
pub(in crate::composition::host) fn provision_native_toolchain(
    open_claw: &openclaw::driver::OpenClawInput,
) -> Arc<::toolchain::NativeToolchain> {
    ::toolchain::NativeToolchain::local(
        open_claw.working_directory.clone(),
        open_claw.guardian_executable.clone(),
    )
}
