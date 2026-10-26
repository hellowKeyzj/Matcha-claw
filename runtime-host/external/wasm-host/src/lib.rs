//! Neutral Component execution. Owners supply exact bindings and host cleanup.
//! No WASI, filesystem, network, process access or package/native-code loader.
mod error;
mod execution;

use std::{
    collections::{HashMap, VecDeque},
    hash::{Hash, Hasher},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use foundation::execution::{OwnedTask, TaskHandle};
use sha2::{Digest, Sha256};
use wasmtime::component::{Component, InstancePre, Linker};

pub use error::{ExecutionError, FailureKind, InvocationError, Resource, Stage};
pub use execution::{CallControl, CallFuture, CallState, CleanupFuture, ExecutionLimits};

/// Reuse this Wasmtime version for generated owner bindings; not a business API.
pub use wasmtime;

#[derive(Clone, Copy, Debug)]
pub struct EngineLimits {
    pub artifact_bytes: usize,
    pub concurrent_compilations: usize,
    pub cached_components: usize,
    /// Compiled image bytes only, not total Wasmtime metadata or Host RSS.
    pub cached_image_bytes: usize,
}

#[derive(Clone)]
pub struct Engine {
    inner: Arc<EngineInner>,
}

struct EngineInner {
    engine: wasmtime::Engine,
    compatibility: [u8; 32],
    limits: EngineLimits,
    compiling: AtomicUsize,
    cache: Mutex<ComponentCache>,
}

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
struct CacheKey {
    content: [u8; 32],
    compatibility: [u8; 32],
}

#[derive(Default)]
struct ComponentCache {
    entries: HashMap<CacheKey, (Component, usize)>,
    insertion_order: VecDeque<CacheKey>,
    image_bytes: usize,
}

impl Engine {
    pub fn try_new(limits: EngineLimits) -> Result<Self, ExecutionError> {
        if limits.artifact_bytes == 0 || limits.concurrent_compilations == 0 {
            return Err(ExecutionError::new(
                Stage::Engine,
                FailureKind::InvalidLimit,
            ));
        }
        let mut config = wasmtime::Config::new();
        config
            .wasm_component_model(true)
            .consume_fuel(true)
            .epoch_interruption(true)
            .concurrency_support(false);
        let engine = wasmtime::Engine::new(&config)
            .map_err(|cause| ExecutionError::from_wasmtime(Stage::Engine, cause))?;
        // Hash the official environment, including precise engine version, target,
        // compiler/ISA flags and features. Cache objects never cross this Engine.
        let mut hash = CompatibilityHash(Sha256::new());
        engine.precompile_compatibility_hash().hash(&mut hash);
        let compatibility = hash.0.finalize().into();
        Ok(Self {
            inner: Arc::new(EngineInner {
                engine,
                compatibility,
                limits,
                compiling: AtomicUsize::new(0),
                cache: Mutex::new(ComponentCache::default()),
            }),
        })
    }

    pub fn raw_engine(&self) -> &wasmtime::Engine {
        &self.inner.engine
    }

    /// Synchronous CPU work: run through the owner's existing execution path.
    /// The exact bytes are hashed before cache lookup and compilation. Native
    /// serialized/AOT artifacts and core modules are never accepted here.
    pub fn compile(
        &self,
        bytes: &[u8],
        expected_sha256: [u8; 32],
    ) -> Result<Component, ExecutionError> {
        let limits = self.inner.limits;
        if bytes.len() > limits.artifact_bytes {
            return Err(ExecutionError::new(
                Stage::Load,
                FailureKind::ResourceExceeded {
                    resource: Resource::ArtifactBytes,
                    limit: limits.artifact_bytes,
                    requested: bytes.len(),
                },
            ));
        }
        if <[u8; 32]>::from(Sha256::digest(bytes)) != expected_sha256 {
            return Err(ExecutionError::new(
                Stage::Load,
                FailureKind::DigestMismatch,
            ));
        }
        if !bytes.starts_with(b"\0asm\x0d\0\x01\0") {
            return Err(ExecutionError::new(
                Stage::Load,
                FailureKind::NotComponentBinary,
            ));
        }
        let key = CacheKey {
            content: expected_sha256,
            compatibility: self.inner.compatibility,
        };
        if let Some((component, _)) = self.cache()?.entries.get(&key) {
            return Ok(component.clone());
        }
        self.inner
            .compiling
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < limits.concurrent_compilations).then_some(count + 1)
            })
            .map_err(|_| ExecutionError::new(Stage::Compile, FailureKind::CompileBusy))?;
        let _permit = CompilePermit(&self.inner.compiling);
        // No cache lock during validation/code generation. Concurrent misses may
        // compile twice, but compile admission is bounded and never queues work.
        let component = Component::from_binary(self.raw_engine(), bytes)
            .map_err(|cause| ExecutionError::from_wasmtime(Stage::Compile, cause))?;
        let image = component.image_range();
        let image_bytes = image.end.addr() - image.start.addr();
        if limits.cached_components != 0 && image_bytes <= limits.cached_image_bytes {
            let mut cache = self.cache()?;
            if !cache.entries.contains_key(&key) {
                while cache.entries.len() >= limits.cached_components
                    || image_bytes > limits.cached_image_bytes - cache.image_bytes
                {
                    let Some(oldest) = cache.insertion_order.pop_front() else {
                        break;
                    };
                    if let Some((_, bytes)) = cache.entries.remove(&oldest) {
                        cache.image_bytes -= bytes;
                    }
                }
                cache.image_bytes += image_bytes;
                cache.insertion_order.push_back(key);
                cache.entries.insert(key, (component.clone(), image_bytes));
            }
        }
        Ok(component)
    }

    /// An empty Linker is supplied by the owner and receives only its exact WIT
    /// bindings. This method resolves imports; it never adds unknown-import traps.
    pub fn link<T: Send + 'static>(
        &self,
        linker: &Linker<CallState<T>>,
        component: &Component,
    ) -> Result<InstancePre<CallState<T>>, ExecutionError> {
        if !wasmtime::Engine::same(self.raw_engine(), component.engine())
            || !wasmtime::Engine::same(self.raw_engine(), linker.engine())
        {
            return Err(ExecutionError::new(
                Stage::Link,
                FailureKind::EngineMismatch,
            ));
        }
        linker
            .instantiate_pre(component)
            .map_err(|cause| ExecutionError::from_wasmtime(Stage::Link, cause))
    }

    /// Start once per shared Engine. Host owns and explicitly cancel/joins this
    /// Foundation task; an individual invocation never changes global epoch.
    pub fn spawn_epoch_clock(
        &self,
        interval: Duration,
    ) -> Result<(OwnedTask<()>, TaskHandle), ExecutionError> {
        if interval.is_zero() {
            return Err(ExecutionError::new(
                Stage::Engine,
                FailureKind::InvalidLimit,
            ));
        }
        let engine = self.raw_engine().weak();
        Ok(OwnedTask::spawn(move |cancellation| async move {
            loop {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => break,
                    _ = tokio::time::sleep(interval) => {
                        let Some(engine) = engine.upgrade() else { break };
                        engine.increment_epoch();
                    }
                }
            }
        }))
    }

    fn cache(&self) -> Result<std::sync::MutexGuard<'_, ComponentCache>, ExecutionError> {
        self.inner
            .cache
            .lock()
            .map_err(|_| ExecutionError::new(Stage::Compile, FailureKind::CachePoisoned))
    }
}

struct CompilePermit<'a>(&'a AtomicUsize);
impl Drop for CompilePermit<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Release);
    }
}

struct CompatibilityHash(Sha256);
impl Hasher for CompatibilityHash {
    fn write(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }
    fn finish(&self) -> u64 {
        let digest = self.0.clone().finalize();
        u64::from_le_bytes(digest[..8].try_into().expect("SHA256 has eight bytes"))
    }
}
