use serde_json::{Value, json};

use crate::{
    ProviderAccountMutationKind, ProviderAccountView, ProviderAccountsDelivery,
    ProviderCommitOutcome, ProviderNativeConfigurationView, ProviderPersistedOutcome,
};

pub(crate) fn status_code(delivery: &ProviderAccountsDelivery) -> u16 {
    match delivery {
        ProviderAccountsDelivery::List(_) | ProviderAccountsDelivery::Account(_) => 200,
        ProviderAccountsDelivery::Stored {
            persisted, commit, ..
        }
        | ProviderAccountsDelivery::Deleted {
            persisted, commit, ..
        } if !super::mutation_unknown(*persisted, *commit) => 200,
        ProviderAccountsDelivery::Stored { .. }
        | ProviderAccountsDelivery::Deleted { .. }
        | ProviderAccountsDelivery::Unknown { .. } => 409,
        ProviderAccountsDelivery::Rejected => 422,
        ProviderAccountsDelivery::Missing => 404,
        ProviderAccountsDelivery::Unavailable => 503,
    }
}

pub(crate) fn body(delivery: &ProviderAccountsDelivery) -> Value {
    match delivery {
        ProviderAccountsDelivery::List(accounts) => {
            json!({ "accounts": accounts.iter().map(account_json).collect::<Vec<_>>() })
        }
        ProviderAccountsDelivery::Account(account) => {
            json!({ "account": account_json(account) })
        }
        ProviderAccountsDelivery::Stored {
            account,
            persisted,
            native,
            commit,
        } => mutation_body(
            Some(&account_json(account)),
            "stored",
            *persisted,
            native.clone(),
            *commit,
            "Provider mutation commit outcome is unknown; reopen before retrying",
        ),
        ProviderAccountsDelivery::Deleted {
            persisted,
            native,
            commit,
        } => mutation_body(
            None,
            "deleted",
            *persisted,
            native.clone(),
            *commit,
            "Provider mutation commit outcome is unknown; reopen before retrying",
        ),
        ProviderAccountsDelivery::Rejected => {
            super::fixed_error("Provider account request was rejected")
        }
        ProviderAccountsDelivery::Missing => super::fixed_error("Provider account is unknown"),
        ProviderAccountsDelivery::Unknown {
            desired,
            persisted,
            native,
            commit,
        } => mutation_body(
            None,
            desired_status(*desired),
            *persisted,
            native.clone(),
            *commit,
            "Provider mutation commit outcome is unknown; reopen before retrying",
        ),
        ProviderAccountsDelivery::Unavailable => {
            super::fixed_error("Provider accounts are unavailable")
        }
    }
}

fn mutation_body(
    account: Option<&Value>,
    desired_status: &str,
    persisted: ProviderPersistedOutcome,
    native: ProviderNativeConfigurationView,
    commit: ProviderCommitOutcome,
    unknown_error: &'static str,
) -> Value {
    let desired = json!({ "status": desired_status });
    let unknown = super::mutation_unknown(persisted, commit);
    let persisted_json = super::persisted_json(persisted);
    let native_json = super::native_json(native);
    let commit_name = super::commit_name(commit);
    if unknown {
        return json!({
            "success": false,
            "code": "commit-outcome-unknown",
            "error": unknown_error,
            "receipt": {
                "desired": desired,
                "persisted": persisted_json,
                "native": native_json,
                "commit": commit_name,
            },
        });
    }
    let mut body = json!({
        "success": true,
        "desired": desired,
        "persisted": persisted_json,
        "native": native_json,
        "commit": commit_name,
    });
    if let Some(account) = account {
        body.as_object_mut()
            .expect("account mutation body is an object")
            .insert("account".into(), account.clone());
    }
    body
}

const fn desired_status(kind: ProviderAccountMutationKind) -> &'static str {
    match kind {
        ProviderAccountMutationKind::Stored => "stored",
        ProviderAccountMutationKind::Deleted => "deleted",
    }
}

fn account_json(account: &ProviderAccountView) -> Value {
    let mut value = json!({
        "id": account.id,
        "provider": account.provider,
        "label": account.label,
        "enabled": account.enabled,
        "kind": account.kind,
        "authMode": account.auth_mode,
        "revision": account.revision,
    });
    let object = value
        .as_object_mut()
        .expect("provider account JSON is an object");
    if let Some(endpoint) = &account.endpoint {
        object.insert("endpoint".into(), Value::String(endpoint.clone()));
    }
    if let Some(protocol) = account.protocol {
        object.insert("protocol".into(), Value::String(protocol.to_owned()));
    }
    if let Some(protocol) = account.media_protocol {
        object.insert("mediaProtocol".into(), Value::String(protocol.to_owned()));
    }
    value
}
