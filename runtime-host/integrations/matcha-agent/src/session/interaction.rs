use super::rpc::{self, Failure};
use crate::client::Client;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};
use sessions_module::question::{
    NativeApplication, QuestionAnswer, QuestionAvailability, QuestionDelivery, QuestionFailure,
    QuestionReceipt, QuestionRequest, QuestionTarget, QuestionView,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pending {
    pub session_id: String,
    pub instance_id: String,
    pub native_request_id: String,
    pub run_id: Option<String>,
    pub category: String,
    pub request: Value,
    pub availability: QuestionAvailability,
    pub delivery: QuestionDelivery,
    pub native_application: NativeApplication,
    pub requested_at_ms: u64,
    pub updated_at_ms: u64,
    pub failure: Option<QuestionFailure>,
}
impl Pending {
    pub fn target(&self) -> QuestionTarget {
        QuestionTarget {
            session_id: self.session_id.clone(),
            instance_id: self.instance_id.clone(),
            native_request_id: self.native_request_id.clone(),
        }
    }
    pub fn receipt(&self) -> Result<QuestionReceipt, Failure> {
        let receipt = QuestionReceipt {
            target: self.target(),
            run_id: self.run_id.clone(),
            availability: self.availability,
            delivery: self.delivery,
            native_application: self.native_application,
            requested_at_ms: self.requested_at_ms,
            updated_at_ms: self.updated_at_ms,
            failure: self.failure.clone(),
        };
        receipt.validate().map_err(|_| Failure::InvalidReadback)?;
        Ok(receipt)
    }
    pub fn question(&self) -> Result<QuestionView, Failure> {
        let request = match self.category.as_str() {
            "askUserQuestion"
                if self.request["subtype"] == "can_use_tool"
                    && self.request["tool_name"] == "AskUserQuestion" =>
            {
                QuestionRequest::AskUserQuestion {
                    questions: rpc::decode(self.request["input"]["questions"].clone())?,
                }
            }
            "elicitationForm" if self.request["subtype"] == "elicitation" => {
                QuestionRequest::ElicitationForm {
                    mcp_server_name: field(&self.request, "mcp_server_name")?,
                    message: field(&self.request, "message")?,
                    requested_schema: self
                        .request
                        .get("requested_schema")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .map(rpc::decode)
                        .transpose()?,
                }
            }
            "elicitationUrl" if self.request["subtype"] == "elicitation" => {
                QuestionRequest::ElicitationUrl {
                    mcp_server_name: field(&self.request, "mcp_server_name")?,
                    message: field(&self.request, "message")?,
                    url: field(&self.request, "url")?,
                    elicitation_id: field(&self.request, "elicitation_id")?,
                }
            }
            _ => return Err(Failure::InvalidReadback),
        };
        let receipt = self.receipt()?;
        let view = QuestionView {
            target: receipt.target,
            run_id: receipt.run_id,
            request,
            availability: receipt.availability,
            delivery: receipt.delivery,
            native_application: receipt.native_application,
            requested_at_ms: receipt.requested_at_ms,
            updated_at_ms: receipt.updated_at_ms,
        };
        view.validate().map_err(|_| Failure::InvalidReadback)?;
        Ok(view)
    }
    pub fn approval_id(&self) -> Result<String, Failure> {
        if self.category != "permission"
            || self.request["subtype"] != "can_use_tool"
            || self.request["tool_name"] == "AskUserQuestion"
        {
            return Err(Failure::InvalidReadback);
        }
        self.receipt()?;
        approval_id(&self.target())
    }
}
pub(crate) fn approval_id(target: &QuestionTarget) -> Result<String, Failure> {
    target.validate().map_err(|_| Failure::InvalidReadback)?;
    let encoded = serde_json::to_vec(&[&target.instance_id, &target.native_request_id])
        .map_err(|_| Failure::InvalidReadback)?;
    let id = format!("native:{}", URL_SAFE_NO_PAD.encode(encoded));
    if id.len() > sessions_module::state::MAX_ID_BYTES {
        return Err(Failure::InvalidReadback);
    }
    Ok(id)
}
fn field(value: &Value, key: &str) -> Result<String, Failure> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(Failure::InvalidReadback)
}

pub(crate) async fn pending(
    client: &Client,
    id: &str,
    family: &str,
) -> Result<Vec<Pending>, Failure> {
    let value = rpc::call(
        client,
        &format!("{family}.list"),
        json!({"sessionId":id,"includeResolved":true}),
    )
    .await?;
    let pending: Vec<Pending> = rpc::decode(
        value
            .get("items")
            .cloned()
            .ok_or(Failure::InvalidReadback)?,
    )?;
    for item in &pending {
        if item.session_id != id {
            return Err(Failure::InvalidReadback);
        }
        item.receipt()?;
    }
    Ok(pending)
}
pub async fn list_questions(client: &Client, id: &str) -> Result<Vec<QuestionView>, Failure> {
    rpc::get(client, id, None).await?;
    pending(client, id, "questions")
        .await?
        .iter()
        .map(Pending::question)
        .collect()
}
pub struct ResponseFailure {
    pub failure: Failure,
    pub attempted: bool,
}
pub async fn respond_to_question(
    client: &Client,
    target: QuestionTarget,
    answer: QuestionAnswer,
) -> Result<QuestionReceipt, ResponseFailure> {
    let response = async {
        target.validate().map_err(|_| Failure::InvalidInput)?;
        answer.validate().map_err(|_| Failure::InvalidInput)?;
        rpc::get(client, &target.session_id, None).await?;
        let questions = pending(client, &target.session_id, "questions").await?;
        let question = questions
            .iter()
            .find(|item| item.target() == target)
            .ok_or(Failure::InvalidInput)?
            .question()?;
        if question.availability != QuestionAvailability::Pending
            || question.delivery != QuestionDelivery::NotSent
            || !answer.matches_request(&question.request)
        {
            return Err(Failure::InvalidInput);
        }
        serde_json::to_value(answer).map_err(|_| Failure::InvalidInput)
    }
    .await
    .map_err(|failure| ResponseFailure {
        failure,
        attempted: false,
    })?;
    let value = rpc::call(client,"questions.respond",json!({"sessionId":target.session_id,"instanceId":target.instance_id,"nativeRequestId":target.native_request_id,"response":response})).await
        .map_err(|failure| ResponseFailure { failure, attempted: true })?;
    receipt(&value, &target).ok_or(ResponseFailure {
        failure: Failure::InvalidReadback,
        attempted: true,
    })
}
pub(crate) fn receipt(value: &Value, target: &QuestionTarget) -> Option<QuestionReceipt> {
    let candidate = QuestionReceipt {
        target: QuestionTarget {
            session_id: value.get("sessionId")?.as_str()?.to_owned(),
            instance_id: value.get("instanceId")?.as_str()?.to_owned(),
            native_request_id: value.get("nativeRequestId")?.as_str()?.to_owned(),
        },
        run_id: serde_json::from_value(value.get("runId").cloned().unwrap_or(Value::Null)).ok()?,
        availability: serde_json::from_value(value.get("availability")?.clone()).ok()?,
        delivery: serde_json::from_value(value.get("delivery")?.clone()).ok()?,
        native_application: serde_json::from_value(value.get("nativeApplication")?.clone()).ok()?,
        requested_at_ms: value.get("requestedAtMs")?.as_u64()?,
        updated_at_ms: value.get("updatedAtMs")?.as_u64()?,
        failure: serde_json::from_value(value.get("failure").cloned().unwrap_or(Value::Null))
            .ok()?,
    };
    (candidate.target == *target && candidate.validate().is_ok()).then_some(candidate)
}
