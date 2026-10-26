//! Typed proposal contracts and external consumers. This crate owns no World authority.

pub use world_protocol as protocol;

pub mod methods;
#[cfg(not(target_arch = "wasm32"))]
mod oracle;
#[cfg(not(target_arch = "wasm32"))]
pub mod process;
#[cfg(any(
    not(target_arch = "wasm32"),
    feature = "packaging",
    not(any(
        feature = "guest-projection",
        feature = "guest-reconcile",
        feature = "guest-oracle",
        feature = "guest-policy"
    ))
))]
pub mod source;

#[cfg(feature = "packaging")]
pub mod package;

#[cfg(any(
    feature = "guest-projection",
    feature = "guest-reconcile",
    feature = "guest-oracle",
    feature = "guest-policy"
))]
mod guest;

#[cfg(any(
    all(feature = "guest-projection", feature = "guest-reconcile"),
    all(feature = "guest-projection", feature = "guest-oracle"),
    all(feature = "guest-reconcile", feature = "guest-oracle"),
    all(feature = "guest-policy", feature = "guest-projection"),
    all(feature = "guest-policy", feature = "guest-reconcile"),
    all(feature = "guest-policy", feature = "guest-oracle"),
))]
compile_error!("build one component world at a time");
