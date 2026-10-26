use super::*;

variant!(world_protocol::api::UploadFailure, UploadFailure; units [NotFound, Expired, AlreadySealed, ChunkTooLarge, ChunkDigestMismatch, SizeMismatch, DigestMismatch, AdmissionMismatch]; tuples []; records [OffsetMismatch { expected, actual } => UploadFailureOffsetMismatch, Storage { failure } => UploadFailureStorage]);

record!(world_protocol::api::DiscoverQuery, DiscoverQuery; include_capabilities);
record!(world_protocol::api::ExplainQuery, ExplainQuery; assertion, read_mode);
record!(world_protocol::api::ObserveRequest, ObserveRequest; observations);
record!(world_protocol::api::ProposeChange, ProposeChange; task, compile, base_release, operations, evidence, cases);
variant!(world_protocol::api::PeerOperation, PeerOperation; units []; tuples [Discover, Query, Explain, ActionPropose, ActionSubmit, ActionStatus, Observe, ChangePropose, BranchTest]; records []);
record!(world_protocol::api::PeerRequest, PeerRequest; world, request_id, operation);
unit_enum!(world_protocol::api::WorldStatus, WorldStatus; NotConfigured, Ready, Draining, Restoring, Deleting, Retained, Unavailable);
unit_enum!(world_protocol::api::ReadGuarantee, ReadGuarantee; Projected, Authoritative, After);
record!(world_protocol::api::MaterialScope, MaterialScope; scope, access, retention);
record!(world_protocol::api::WorldDescription, WorldDescription; world, revision, incarnation, status, operations, active_release, active_release_head, editing_context, material_scopes, read_modes);
variant!(world_protocol::api::PeerResponse, PeerResponse; units []; tuples [Discover, Query, Explain, ActionPropose, Accepted, ActionStatus, Change]; records []);
