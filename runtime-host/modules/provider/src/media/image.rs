use reqwest::{Client, Url, multipart::Form};
use serde_json::{Value, json};

use crate::{ProviderModel, llm_client::LlmCredential};

use super::{Failure, MAX_OUTPUT_BYTES, MAX_OUTPUT_COUNT, Output, Request, pixel_size, wire};

pub(super) fn validate_openai(model: &ProviderModel, request: &Request) -> Result<(), Failure> {
    if request.duration_seconds.is_some() || model.aspect_ratio().is_some() {
        return Err(Failure::Unsupported);
    }
    if model.model_id() == "dall-e-3"
        && (!request.images.is_empty() || request.count.unwrap_or(1) != 1)
        || model.model_id() == "dall-e-2" && request.images.len() > 1
    {
        return Err(Failure::Unsupported);
    }
    if let Some(size) = request.size.as_deref().or(model.resolution()) {
        if size != "auto"
            && !pixel_size::for_model(model.model_id())
                .map_or_else(|| is_pixel_size(size), |limits| limits.supports(size))
        {
            return Err(Failure::Unsupported);
        }
    }
    Ok(())
}

pub(super) async fn openai(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<Output, Failure> {
    let count = request.count.unwrap_or(1);
    let size = request.size.as_deref().or(model.resolution());
    let is_gpt_image =
        model.model_id().starts_with("gpt-image-") || model.model_id() == "chatgpt-image-latest";
    let response = if request.images.is_empty() {
        let mut body = json!({ "model": model.model_id(), "prompt": request.prompt, "n": count });
        if let Some(size) = size {
            body["size"] = json!(size);
        }
        if let Some(quality) = model.quality() {
            body["quality"] = json!(quality);
        }
        if is_gpt_image {
            body["output_format"] = json!("png");
        } else {
            body["response_format"] = json!("b64_json");
        }
        wire::json_body(
            client
                .post(wire::resource(endpoint, &["images", "generations"])?)
                .bearer_auth(credential.token()),
            body,
        )?
    } else {
        let mut form = Form::new()
            .text("model", model.model_id().to_owned())
            .text("prompt", request.prompt)
            .text("n", count.to_string());
        if let Some(size) = size {
            form = form.text("size", size.to_owned());
        }
        if let Some(quality) = model.quality() {
            form = form.text("quality", quality.to_owned());
        }
        if is_gpt_image {
            form = form.text("output_format", "png");
        } else {
            form = form.text("response_format", "b64_json");
        }
        let field = if request.images.len() > 1 {
            "image[]"
        } else {
            "image"
        };
        for image in &request.images {
            form = form.part(field, wire::image_part(image)?);
        }
        if let Some(mask) = &request.mask {
            form = form.part("mask", wire::image_part(mask)?);
        }
        client
            .post(wire::resource(endpoint, &["images", "edits"])?)
            .bearer_auth(credential.token())
            .multipart(form)
    };
    let mut value = wire::json(response, wire::MAX_JSON_BYTES).await?;
    let images = value
        .get_mut("data")
        .and_then(Value::as_array_mut)
        .ok_or(Failure::InvalidResponse)?;
    if images.len() != usize::from(count) {
        return Err(Failure::InvalidResponse);
    }
    let mut remaining = MAX_OUTPUT_BYTES;
    let outputs = images
        .iter_mut()
        .map(|image| {
            let data = image
                .get_mut("b64_json")
                .and_then(wire::take_string)
                .ok_or(Failure::InvalidResponse)?;
            wire::image_output(data, &mut remaining)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Output { outputs })
}

pub(super) fn validate_google(model: &ProviderModel, request: &Request) -> Result<(), Failure> {
    if !model
        .model_id()
        .trim_start_matches("models/")
        .starts_with("gemini-")
        || request.mask.is_some()
        || request.duration_seconds.is_some()
        || request.count.unwrap_or(1) != 1
        || model.quality().is_some()
        || request
            .size
            .as_deref()
            .or(model.resolution())
            .is_some_and(|size| !matches!(size, "512" | "1K" | "2K" | "4K"))
    {
        return Err(Failure::Unsupported);
    }
    Ok(())
}

pub(super) async fn google(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<Output, Failure> {
    let mut parts = vec![json!({"text": request.prompt})];
    parts.extend(
        request
            .images
            .into_iter()
            .map(|image| json!({"inlineData": {"data": image.data, "mimeType": image.mime_type}})),
    );
    let mut config = json!({"responseModalities": ["TEXT", "IMAGE"]});
    let mut image_config = json!({});
    if let Some(size) = request.size.as_deref().or(model.resolution()) {
        image_config["imageSize"] = json!(size);
    }
    if let Some(aspect_ratio) = model.aspect_ratio() {
        image_config["aspectRatio"] = json!(aspect_ratio);
    }
    if image_config
        .as_object()
        .is_some_and(|config| !config.is_empty())
    {
        config["imageConfig"] = image_config;
    }
    let body = json!({"contents": [{"role": "user", "parts": parts}], "generationConfig": config});
    let model_id = format!(
        "{}:generateContent",
        model.model_id().trim_start_matches("models/")
    );
    let request = wire::json_body(
        client
            .post(wire::resource(endpoint, &["models", &model_id])?)
            .header("x-goog-api-key", credential.token()),
        body,
    )?;
    let mut value = wire::json(request, wire::MAX_JSON_BYTES).await?;
    let candidates = value
        .get_mut("candidates")
        .and_then(Value::as_array_mut)
        .ok_or(Failure::GenerationFailed)?;
    if candidates.len() != 1 {
        return Err(Failure::InvalidResponse);
    }
    let parts = candidates[0]
        .get_mut("content")
        .and_then(|content| content.get_mut("parts"))
        .and_then(Value::as_array_mut)
        .ok_or(Failure::GenerationFailed)?;
    let mut outputs = Vec::new();
    let mut remaining = MAX_OUTPUT_BYTES;
    for part in parts {
        let inline_key = if part.get("inlineData").is_some() {
            "inlineData"
        } else {
            "inline_data"
        };
        let Some(inline) = part.get_mut(inline_key) else {
            continue;
        };
        if outputs.len() == usize::from(MAX_OUTPUT_COUNT) {
            return Err(Failure::InvalidResponse);
        }
        let mime_type = inline
            .get("mimeType")
            .or_else(|| inline.get("mime_type"))
            .and_then(Value::as_str)
            .ok_or(Failure::InvalidResponse)?
            .to_owned();
        let data = inline
            .get_mut("data")
            .and_then(wire::take_string)
            .ok_or(Failure::InvalidResponse)?;
        let output = wire::image_output(data, &mut remaining)?;
        if output.mime_type != mime_type {
            return Err(Failure::InvalidResponse);
        }
        outputs.push(output);
    }
    if outputs.is_empty() {
        return Err(Failure::GenerationFailed);
    }
    Ok(Output { outputs })
}

pub(super) fn is_pixel_size(size: &str) -> bool {
    size.split_once('x').is_some_and(|(width, height)| {
        width.parse::<u32>().ok().is_some_and(|width| width > 0)
            && height.parse::<u32>().ok().is_some_and(|height| height > 0)
    })
}
