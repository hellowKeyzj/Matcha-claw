use super::*;

variant!(world_protocol::materials::MaterialFailure, MaterialFailure; units [InputInvalid, ReadFailed, WriteFailed, SyncFailed, PublishFailed, ContentNotFound, RetainedReferences, CleanupFailed, UnsupportedFormat, CorruptContent, EncryptedContent, ParserUnavailable, SizeLimit, OcrUnavailable, TranscriptionUnavailable, IncompleteLocation, DigestMismatch, Deleted, RetentionDenied, Cancelled, InternalFault]; tuples []; records [VersionContentUnavailable { reference } => MaterialFailureVersionContentUnavailable, SourceVersionMissing { reference } => MaterialFailureSourceVersionMissing]);

record!(world_protocol::materials::BlobRef, BlobRef; digest, byte_size);
record!(world_protocol::materials::SourceVersionRef, SourceVersionRef; world, source_id, version_id);
record!(world_protocol::materials::AccessPolicyRef, AccessPolicyRef; policy_id, revision, labels);
