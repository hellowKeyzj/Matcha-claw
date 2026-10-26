CREATE FUNCTION world_preserve_blob_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (to_jsonb(NEW)-'released_at'-'expires_at') IS DISTINCT FROM (to_jsonb(OLD)-'released_at'-'expires_at')
       OR (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at) THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='world_reference_immutable', MESSAGE='reference identity or release cannot change';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER world_blob_pin_preserve BEFORE UPDATE ON world_blob_pin FOR EACH ROW EXECUTE FUNCTION world_preserve_blob_reference();
CREATE TRIGGER world_content_reference_preserve BEFORE UPDATE ON world_content_reference FOR EACH ROW EXECUTE FUNCTION world_preserve_blob_reference();
CREATE TRIGGER world_content_hold_preserve BEFORE UPDATE ON world_content_hold FOR EACH ROW EXECUTE FUNCTION world_preserve_blob_reference();
CREATE TRIGGER world_package_retention_preserve BEFORE UPDATE ON world_package_retention FOR EACH ROW EXECUTE FUNCTION world_preserve_blob_reference();
CREATE FUNCTION world_admit_package_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gc_state text;
BEGIN
    IF world_is_prepared_import(NEW.tenant_id,NEW.world_id) THEN RETURN NEW; END IF;
    SELECT state INTO gc_state FROM world_package_gc WHERE tenant_id=NEW.tenant_id AND world_id=NEW.world_id AND package_digest=NEW.package_digest FOR UPDATE;
    IF gc_state IS DISTINCT FROM 'live' THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='world_package_gc_admission', MESSAGE='package is not available for new retention';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER world_package_retention_admission BEFORE INSERT ON world_package_retention FOR EACH ROW EXECUTE FUNCTION world_admit_package_reference();
CREATE FUNCTION world_lock_alias_range() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb;
BEGIN
    row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    PERFORM 1 FROM world_alias_range WHERE tenant_id=row_data->>'tenant_id' AND world_id=row_data->>'world_id'
        AND source_id=row_data->>'source_id' AND namespace=row_data->>'namespace' AND native_key=row_data->>'native_key' FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='world_alias_range_required', MESSAGE='source alias range must be registered';
    END IF;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER world_source_alias_guard BEFORE INSERT OR UPDATE OR DELETE ON world_source_alias_current FOR EACH ROW EXECUTE FUNCTION world_lock_alias_range();
CREATE FUNCTION world_preserve_identity_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (to_jsonb(NEW)-'revision') IS DISTINCT FROM (to_jsonb(OLD)-'revision') OR NEW.revision <= OLD.revision THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='world_identity_type_immutable', MESSAGE='stable identity type cannot change';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER world_object_identity_type BEFORE UPDATE ON world_object_identity FOR EACH ROW EXECUTE FUNCTION world_preserve_identity_type();
CREATE TRIGGER world_relation_identity_type BEFORE UPDATE ON world_relation_identity FOR EACH ROW EXECUTE FUNCTION world_preserve_identity_type();
-- Authority changes and admission use the same current world authority row; no model grants authority.
CREATE FUNCTION world_bump_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb;
BEGIN
    row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    IF TG_OP='INSERT' AND world_is_prepared_import(row_data->>'tenant_id',row_data->>'world_id') THEN RETURN NEW; END IF;
    UPDATE world_authority_head SET policy_epoch=policy_epoch+CASE WHEN TG_TABLE_NAME='world_auth_policy' THEN 1 ELSE 0 END,
        grant_epoch=grant_epoch+CASE WHEN TG_TABLE_NAME='world_auth_policy' THEN 0 ELSE 1 END
        WHERE tenant_id=row_data->>'tenant_id' AND world_id=row_data->>'world_id';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='world_authority_required', MESSAGE='authority head must be initialized';
    END IF;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER world_auth_principal_epoch BEFORE INSERT OR UPDATE OR DELETE ON world_auth_principal FOR EACH ROW EXECUTE FUNCTION world_bump_authority();
CREATE TRIGGER world_auth_grant_epoch BEFORE INSERT OR UPDATE OR DELETE ON world_auth_grant FOR EACH ROW EXECUTE FUNCTION world_bump_authority();
CREATE TRIGGER world_auth_delegation_epoch BEFORE INSERT OR UPDATE OR DELETE ON world_auth_delegation FOR EACH ROW EXECUTE FUNCTION world_bump_authority();
CREATE TRIGGER world_auth_execution_epoch BEFORE INSERT OR UPDATE OR DELETE ON world_auth_execution FOR EACH ROW EXECUTE FUNCTION world_bump_authority();
CREATE TRIGGER world_auth_policy_epoch BEFORE INSERT OR UPDATE OR DELETE ON world_auth_policy FOR EACH ROW EXECUTE FUNCTION world_bump_authority();
CREATE TRIGGER world_auth_approval_epoch BEFORE UPDATE OR DELETE ON world_auth_approval FOR EACH ROW EXECUTE FUNCTION world_bump_authority();
