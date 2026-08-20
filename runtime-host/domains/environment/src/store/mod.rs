mod codec;
mod durable;
mod facts;
mod fault;

pub use durable::EnvironmentStore;
pub use facts::{AppliedEvidence, EnvironmentFacts};
pub use fault::{ApplyEvidenceFault, DecodeFault, DesiredWriteFault, StoreFault, UpgradeFault};

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, OpenOptions},
        io::Write,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use crate::{
        definition::{
            BrowserMode, ChannelAccountId, ChannelDirectMessagePolicy, ChannelOperationalDesired,
            ChannelReference, ConnectorReference, CredentialReference, DesiredConfiguration,
            DesiredDefinition, EnvironmentId, EnvironmentRevision, ExtensionReference,
            PolicyReference, ProviderReference, SecurityPreset, ToolchainReference,
        },
        ports::AppliedProjection,
    };

    use super::{
        durable::{WriterLock, lock_path},
        *,
    };

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    fn path(name: &str) -> PathBuf {
        let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let process = std::process::id();
        std::env::temp_dir().join(format!("matcha-environment-store-{name}-{process}-{id}"))
    }

    fn desired(revision: u64, provider: &str) -> DesiredDefinition {
        DesiredDefinition::new(
            EnvironmentId::try_new("environment:primary").unwrap(),
            EnvironmentRevision::try_new(revision).unwrap(),
            ProviderReference::try_new(provider).unwrap(),
            DesiredConfiguration::try_new(
                vec![ConnectorReference::try_new("connector:slack").unwrap()],
                vec![ExtensionReference::try_new("extension:browser-relay").unwrap()],
                vec![ChannelReference::try_new("channel:discord").unwrap()],
                vec![CredentialReference::try_new("credential:v1:anthropic").unwrap()],
                vec![PolicyReference::try_new("policy:balanced").unwrap()],
                vec![ToolchainReference::try_new("toolchain:bun").unwrap()],
                SecurityPreset::Balanced,
                BrowserMode::Native,
                vec![ChannelOperationalDesired::new(
                    ChannelReference::try_new("channel:discord").unwrap(),
                    ChannelAccountId::try_new("primary").unwrap(),
                    true,
                    ChannelDirectMessagePolicy::Allowlist,
                )],
            )
            .unwrap(),
        )
    }

    fn remove(path: &PathBuf) {
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(lock_path(path));
    }

    fn verified(desired: &DesiredDefinition) -> AppliedProjection {
        AppliedProjection::from_verified_readback(
            desired.environment_id().clone(),
            desired.revision(),
            desired.provider().clone(),
            desired.connectors().to_vec(),
            desired.extensions().to_vec(),
            desired.channels().to_vec(),
            desired.credential_references().to_vec(),
            desired.policies().to_vec(),
            desired.toolchains().to_vec(),
            desired.security_preset(),
            desired.browser_mode(),
            desired.operational_channels().to_vec(),
        )
    }

    fn incomplete_readbacks(desired: &DesiredDefinition) -> [AppliedProjection; 7] {
        let id = desired.environment_id().clone();
        let revision = desired.revision();
        let provider = desired.provider().clone();
        let connectors = desired.connectors().to_vec();
        let extensions = desired.extensions().to_vec();
        let channels = desired.channels().to_vec();
        let credentials = desired.credential_references().to_vec();
        let policies = desired.policies().to_vec();
        let toolchains = desired.toolchains().to_vec();
        let security_preset = desired.security_preset();
        let browser_mode = desired.browser_mode();
        let operational_channels = desired.operational_channels().to_vec();

        [
            AppliedProjection::from_verified_readback(
                id.clone(),
                revision,
                ProviderReference::try_new("provider:other").unwrap(),
                connectors.clone(),
                extensions.clone(),
                channels.clone(),
                credentials.clone(),
                policies.clone(),
                toolchains.clone(),
                security_preset,
                browser_mode,
                operational_channels.clone(),
            ),
            AppliedProjection::from_verified_readback(
                id.clone(),
                revision,
                provider.clone(),
                Vec::new(),
                extensions.clone(),
                channels.clone(),
                credentials.clone(),
                policies.clone(),
                toolchains.clone(),
                security_preset,
                browser_mode,
                operational_channels.clone(),
            ),
            AppliedProjection::from_verified_readback(
                id.clone(),
                revision,
                provider.clone(),
                connectors.clone(),
                Vec::new(),
                channels.clone(),
                credentials.clone(),
                policies.clone(),
                toolchains.clone(),
                security_preset,
                browser_mode,
                operational_channels.clone(),
            ),
            AppliedProjection::from_verified_readback(
                id.clone(),
                revision,
                provider.clone(),
                connectors.clone(),
                extensions.clone(),
                Vec::new(),
                credentials.clone(),
                policies.clone(),
                toolchains.clone(),
                security_preset,
                browser_mode,
                operational_channels.clone(),
            ),
            AppliedProjection::from_verified_readback(
                id.clone(),
                revision,
                provider.clone(),
                connectors.clone(),
                extensions.clone(),
                channels.clone(),
                Vec::new(),
                policies.clone(),
                toolchains.clone(),
                security_preset,
                browser_mode,
                operational_channels.clone(),
            ),
            AppliedProjection::from_verified_readback(
                id.clone(),
                revision,
                provider.clone(),
                connectors.clone(),
                extensions.clone(),
                channels.clone(),
                credentials.clone(),
                Vec::new(),
                toolchains.clone(),
                security_preset,
                browser_mode,
                operational_channels.clone(),
            ),
            AppliedProjection::from_verified_readback(
                id,
                revision,
                provider,
                connectors,
                extensions,
                channels,
                credentials,
                policies,
                Vec::new(),
                security_preset,
                browser_mode,
                operational_channels,
            ),
        ]
    }

    #[test]
    fn operational_channel_codec_is_stable_across_ingress_order() {
        let operational_channel = |channel: &str, account: &str| {
            ChannelOperationalDesired::new(
                ChannelReference::try_new(channel).unwrap(),
                ChannelAccountId::try_new(account).unwrap(),
                true,
                ChannelDirectMessagePolicy::Pairing,
            )
        };
        let definition = |operational_channels| {
            DesiredDefinition::new(
                EnvironmentId::try_new("environment:primary").unwrap(),
                EnvironmentRevision::try_new(1).unwrap(),
                ProviderReference::try_new("provider:anthropic").unwrap(),
                DesiredConfiguration::try_new(
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    SecurityPreset::Relaxed,
                    BrowserMode::Relay,
                    operational_channels,
                )
                .unwrap(),
            )
        };
        let first = definition(vec![
            operational_channel("whatsapp", "work"),
            operational_channel("discord", "primary"),
        ]);
        let second = definition(vec![
            operational_channel("discord", "primary"),
            operational_channel("whatsapp", "work"),
        ]);

        assert_eq!(
            codec::encode_frame(1, &[EnvironmentFacts::new(first, None)]).unwrap(),
            codec::encode_frame(1, &[EnvironmentFacts::new(second, None)]).unwrap(),
        );
    }

    #[test]
    fn desired_and_applied_facts_survive_reopen_without_storing_secret_material() {
        let path = path("reopen");
        let desired = desired(1, "provider:anthropic");
        let id = desired.environment_id().clone();
        let sentinel = "secret-value-must-not-persist";
        let mut store = EnvironmentStore::open(&path).unwrap();

        store.persist_desired(desired.clone()).unwrap();
        store.record_applied(verified(&desired)).unwrap();
        drop(store);

        let reopened = EnvironmentStore::open(&path).unwrap();
        let facts = reopened.environment(&id).unwrap();
        assert_eq!(facts.desired_revision().get(), 1);
        assert_eq!(facts.applied().unwrap().revision().get(), 1);
        assert!(facts.has_current_applied_evidence());
        assert_eq!(facts.desired().security_preset(), SecurityPreset::Balanced);
        assert_eq!(facts.desired().browser_mode(), BrowserMode::Native);
        assert_eq!(
            facts.desired().operational_channels()[0].account().as_str(),
            "primary"
        );
        assert!(
            !fs::read(&path)
                .unwrap()
                .windows(sentinel.len())
                .any(|value| value == sentinel.as_bytes())
        );
        remove(&path);
    }

    #[test]
    fn disabled_browser_mode_survives_durable_reopen() {
        let path = path("browser-off");
        let mut desired = desired(1, "provider:anthropic");
        let configuration = DesiredConfiguration::try_new(
            desired.connectors().to_vec(),
            desired.extensions().to_vec(),
            desired.channels().to_vec(),
            desired.credential_references().to_vec(),
            desired.policies().to_vec(),
            desired.toolchains().to_vec(),
            desired.security_preset(),
            BrowserMode::Off,
            desired.operational_channels().to_vec(),
        )
        .unwrap();
        desired = DesiredDefinition::new(
            desired.environment_id().clone(),
            desired.revision(),
            desired.provider().clone(),
            configuration,
        );
        let environment_id = desired.environment_id().clone();
        let mut store = EnvironmentStore::open(&path).unwrap();

        store.persist_desired(desired).unwrap();
        drop(store);

        let reopened = EnvironmentStore::open(&path).unwrap();
        assert_eq!(
            reopened
                .environment(&environment_id)
                .unwrap()
                .desired()
                .browser_mode(),
            BrowserMode::Off
        );
        drop(reopened);
        remove(&path);
    }

    #[test]
    fn opening_a_nested_durable_path_creates_its_parent_directory() {
        let root = path("nested");
        let durable_path = root.join("facts.log");

        let store = EnvironmentStore::open(&durable_path).unwrap();

        assert!(durable_path.is_file());
        assert!(store.facts().is_empty());
        drop(store);
        remove(&durable_path);
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn delete_tombstone_survives_reopen_is_idempotent_and_recreate_advances_revision() {
        let path = path("delete-reopen");
        let id = EnvironmentId::try_new("environment:primary").unwrap();
        let mut store = EnvironmentStore::open(&path).unwrap();

        store
            .persist_desired(desired(1, "provider:anthropic"))
            .unwrap();
        store
            .persist_delete(&id, EnvironmentRevision::try_new(1).unwrap())
            .unwrap();
        assert!(store.environment(&id).unwrap().is_tombstone());
        assert!(store.environment(&id).unwrap().applied().is_none());
        store
            .persist_delete(&id, EnvironmentRevision::try_new(1).unwrap())
            .unwrap();
        drop(store);

        let mut reopened = EnvironmentStore::open(&path).unwrap();
        let tombstone = reopened.environment(&id).unwrap();
        assert!(tombstone.is_tombstone());
        assert_eq!(tombstone.desired_revision().get(), 1);
        assert!(tombstone.applied().is_none());
        reopened
            .persist_desired(desired(2, "provider:anthropic"))
            .unwrap();
        assert!(!reopened.environment(&id).unwrap().is_tombstone());
        assert_eq!(
            reopened.environment(&id).unwrap().desired_revision().get(),
            2
        );
        drop(reopened);
        remove(&path);
    }

    #[test]
    fn delete_rejects_stale_foreign_and_unknown_revisions() {
        let path = path("delete-revisions");
        let id = EnvironmentId::try_new("environment:primary").unwrap();
        let mut store = EnvironmentStore::open(&path).unwrap();
        store
            .persist_desired(desired(1, "provider:anthropic"))
            .unwrap();

        assert!(
            store
                .persist_delete(&id, EnvironmentRevision::try_new(2).unwrap())
                .is_err()
        );
        assert!(
            store
                .persist_delete(
                    &EnvironmentId::try_new("environment:foreign").unwrap(),
                    EnvironmentRevision::try_new(1).unwrap(),
                )
                .is_err()
        );
        store
            .persist_delete(&id, EnvironmentRevision::try_new(1).unwrap())
            .unwrap();
        store
            .persist_desired(desired(2, "provider:anthropic"))
            .unwrap();
        assert!(
            store
                .persist_delete(&id, EnvironmentRevision::try_new(1).unwrap())
                .is_err()
        );
        remove(&path);
    }

    #[test]
    fn desired_revisions_start_at_one_advance_once_and_are_idempotent_only_for_identical_facts() {
        let path = path("revision");
        let mut store = EnvironmentStore::open(&path).unwrap();

        assert_eq!(
            store.persist_desired(desired(2, "provider:anthropic")),
            Err(StoreFault::Desired(
                DesiredWriteFault::InitialRevisionRequired
            ))
        );
        store
            .persist_desired(desired(1, "provider:anthropic"))
            .unwrap();
        assert_eq!(
            store.persist_desired(desired(3, "provider:anthropic")),
            Err(StoreFault::Desired(
                DesiredWriteFault::RevisionMustFollowCurrent {
                    current: EnvironmentRevision::try_new(1).unwrap(),
                    received: EnvironmentRevision::try_new(3).unwrap(),
                }
            ))
        );
        assert_eq!(
            store.persist_desired(desired(1, "provider:openai")),
            Err(StoreFault::Desired(DesiredWriteFault::RevisionConflict {
                revision: EnvironmentRevision::try_new(1).unwrap(),
            }))
        );
        assert_eq!(
            store
                .persist_desired(desired(1, "provider:anthropic"))
                .unwrap()
                .desired_revision()
                .get(),
            1
        );
        assert_eq!(
            store
                .persist_desired(desired(2, "provider:anthropic"))
                .unwrap()
                .desired_revision()
                .get(),
            2
        );
        assert_eq!(
            store.persist_desired(desired(1, "provider:anthropic")),
            Err(StoreFault::Desired(DesiredWriteFault::StaleRevision {
                current: EnvironmentRevision::try_new(2).unwrap(),
                received: EnvironmentRevision::try_new(1).unwrap(),
            }))
        );
        remove(&path);
    }

    #[test]
    fn operational_readback_must_exactly_cover_current_desired_facts() {
        let desired = desired(1, "provider:anthropic");
        let incomplete = AppliedProjection::from_verified_readback(
            desired.environment_id().clone(),
            desired.revision(),
            desired.provider().clone(),
            desired.connectors().to_vec(),
            desired.extensions().to_vec(),
            desired.channels().to_vec(),
            desired.credential_references().to_vec(),
            desired.policies().to_vec(),
            desired.toolchains().to_vec(),
            SecurityPreset::Strict,
            desired.browser_mode(),
            desired.operational_channels().to_vec(),
        );

        assert!(!incomplete.covers(&desired));
    }

    #[test]
    fn record_applied_requires_exact_current_revision_and_complete_verified_readback() {
        let path = path("applied");
        let first = desired(1, "provider:anthropic");
        let current = desired(2, "provider:anthropic");
        let id = current.environment_id().clone();
        let mut store = EnvironmentStore::open(&path).unwrap();

        store.persist_desired(first.clone()).unwrap();
        store.persist_desired(current.clone()).unwrap();
        assert_eq!(
            store.record_applied(verified(&first)),
            Err(StoreFault::ApplyEvidence(
                ApplyEvidenceFault::RevisionMismatch {
                    desired: current.revision(),
                    received: first.revision(),
                }
            ))
        );
        assert!(store.environment(&id).unwrap().applied().is_none());

        for incomplete in incomplete_readbacks(&current) {
            assert_eq!(
                store.record_applied(incomplete),
                Err(StoreFault::ApplyEvidence(
                    ApplyEvidenceFault::IncompleteVerification
                ))
            );
            assert!(store.environment(&id).unwrap().applied().is_none());
        }

        store.record_applied(verified(&current)).unwrap();
        assert!(
            store
                .environment(&id)
                .unwrap()
                .has_current_applied_evidence()
        );
        drop(store);

        let reopened = EnvironmentStore::open(&path).unwrap();
        assert!(
            reopened
                .environment(&id)
                .unwrap()
                .has_current_applied_evidence()
        );
        drop(reopened);
        remove(&path);
    }

    #[test]
    fn incomplete_tail_recovers_to_the_last_synced_facts() {
        let path = path("tail");
        let mut store = EnvironmentStore::open(&path).unwrap();
        store
            .persist_desired(desired(1, "provider:anthropic"))
            .unwrap();
        drop(store);

        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&[0xA1, 1, 2, 3])
            .unwrap();

        let reopened = EnvironmentStore::open(&path).unwrap();
        assert_eq!(reopened.facts().len(), 1);
        assert_eq!(reopened.facts()[0].desired_revision().get(), 1);
        let recovered_len = fs::metadata(&path).unwrap().len();
        assert!(recovered_len > codec::HEADER_LEN as u64);
        assert_eq!(fs::read(&path).unwrap().len() as u64, recovered_len);
        remove(&path);
    }

    #[test]
    fn separately_opened_writers_refresh_before_each_commit() {
        let path = path("writers");
        let mut first = EnvironmentStore::open(&path).unwrap();
        let mut second = EnvironmentStore::open(&path).unwrap();
        let id = EnvironmentId::try_new("environment:primary").unwrap();

        first
            .persist_desired(desired(1, "provider:anthropic"))
            .unwrap();
        second
            .persist_desired(desired(2, "provider:anthropic"))
            .unwrap();
        second
            .record_applied(verified(&desired(2, "provider:anthropic")))
            .unwrap();
        drop(first);
        drop(second);

        let reopened = EnvironmentStore::open(&path).unwrap();
        let facts = reopened.environment(&id).unwrap();
        assert_eq!(facts.desired_revision().get(), 2);
        assert_eq!(facts.applied().unwrap().revision().get(), 2);
        assert!(facts.has_current_applied_evidence());
        drop(reopened);
        remove(&path);
    }

    #[test]
    fn unsupported_schema_and_corrupt_committed_frame_fail_closed() {
        let path = path("upgrade");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        file.write_all(&codec::LOG_MAGIC).unwrap();
        file.write_all(&[codec::CURRENT_SCHEMA_VERSION + 1])
            .unwrap();
        file.write_all(&0_u64.to_le_bytes()).unwrap();
        drop(file);
        assert!(matches!(
            EnvironmentStore::open(&path),
            Err(StoreFault::Upgrade(UpgradeFault::UnsupportedSchemaVersion(version)))
                if version == codec::CURRENT_SCHEMA_VERSION + 1
        ));
        remove(&path);
    }

    #[test]
    fn corrupt_committed_frame_and_invalid_applied_evidence_fail_closed() {
        let corrupt_path = path("corruption");
        let mut store = EnvironmentStore::open(&corrupt_path).unwrap();
        store
            .persist_desired(desired(1, "provider:anthropic"))
            .unwrap();
        drop(store);

        let mut content = fs::read(&corrupt_path).unwrap();
        *content
            .last_mut()
            .expect("committed Environment log has a frame payload") ^= 0xFF;
        fs::write(&corrupt_path, content).unwrap();
        assert!(matches!(
            EnvironmentStore::open(&corrupt_path),
            Err(StoreFault::Decode(DecodeFault::CorruptRecord))
        ));
        remove(&corrupt_path);

        let invalid_facts_path = path("invalid-facts");
        let invalid_facts = EnvironmentFacts::new(
            desired(1, "provider:anthropic"),
            Some(AppliedEvidence::new(
                EnvironmentRevision::try_new(2).unwrap(),
            )),
        );
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&invalid_facts_path)
            .unwrap();
        codec::initialize_log(&mut file).unwrap();
        file.write_all(&codec::encode_frame(1, &[invalid_facts]).unwrap())
            .unwrap();
        file.sync_all().unwrap();
        drop(file);

        assert!(matches!(
            EnvironmentStore::open(&invalid_facts_path),
            Err(StoreFault::Decode(DecodeFault::InvalidFacts))
        ));
        remove(&invalid_facts_path);
    }

    #[test]
    fn replay_rejects_desired_history_that_skips_a_revision() {
        let path = path("revision-gap");
        let first = EnvironmentFacts::new(desired(1, "provider:anthropic"), None);
        let skipped = EnvironmentFacts::new(desired(3, "provider:anthropic"), None);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        codec::initialize_log(&mut file).unwrap();
        file.write_all(&codec::encode_frame(1, &[first]).unwrap())
            .unwrap();
        file.write_all(&codec::encode_frame(2, &[skipped]).unwrap())
            .unwrap();
        file.sync_all().unwrap();
        drop(file);

        assert!(matches!(
            EnvironmentStore::open(&path),
            Err(StoreFault::Decode(DecodeFault::InvalidFacts))
        ));
        remove(&path);
    }

    #[test]
    fn single_writer_lock_rejects_opening_and_parallel_mutation_without_lost_update() {
        let path = path("writer");
        let lock = WriterLock::acquire(&lock_path(&path)).unwrap();
        assert!(matches!(
            EnvironmentStore::open(&path),
            Err(StoreFault::WriterBusy)
        ));
        drop(lock);

        let mut first = EnvironmentStore::open(&path).unwrap();
        let lock = WriterLock::acquire(&lock_path(&path)).unwrap();
        assert_eq!(
            first.persist_desired(desired(1, "provider:anthropic")),
            Err(StoreFault::WriterBusy)
        );
        drop(lock);
        first
            .persist_desired(desired(1, "provider:anthropic"))
            .unwrap();
        assert_eq!(first.facts().len(), 1);
        remove(&path);
    }
}
