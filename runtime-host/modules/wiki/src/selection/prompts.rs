use crate::{
    domain::{WikiSelectionInput, WikiSelectionIntent, WikiSelectionReference},
    ports::{WikiIngestLlmMessage, WikiIngestLlmOptions, WikiIngestLlmRequest, WikiIngestLlmRole},
};

pub(crate) fn utf16_prefix(text: &str, limit: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(limit).collect::<Vec<_>>())
}

fn utf16_suffix(text: &str, limit: usize) -> String {
    let start = text.encode_utf16().count().saturating_sub(limit);
    String::from_utf16_lossy(&text.encode_utf16().skip(start).collect::<Vec<_>>())
}

pub(crate) fn request(
    input: &WikiSelectionInput,
    references: &[WikiSelectionReference],
) -> WikiIngestLlmRequest {
    let retrieved_context = if references.is_empty() {
        "No additional knowledge-base results were retrieved.".to_owned()
    } else {
        references
            .iter()
            .enumerate()
            .map(|(index, reference)| {
                format!(
                    "[{}] {}\nPath: {}\n{}",
                    index + 1,
                    reference.title,
                    reference.path,
                    reference.snippet
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let unavailable = "Unavailable because the rendered selection could not be mapped safely to one source range.";
    let prefix = if input.selection.source_mapped {
        utf16_suffix(&input.selection.prefix, 1200)
    } else {
        unavailable.to_owned()
    };
    let suffix = if input.selection.source_mapped {
        utf16_prefix(&input.selection.suffix, 1200)
    } else {
        unavailable.to_owned()
    };
    let prompt = [
        match input.intent {
            WikiSelectionIntent::Edit => "Edit the selected text according to the user's instruction. Return only the replacement text without explanation or an outer Markdown fence.",
            WikiSelectionIntent::Ask => "Answer the user's instruction about the selected text. Use the nearby text only as supporting context.",
        }.to_owned(),
        format!("File: {}", input.relative_path),
        format!("Instruction: {}", input.instruction),
        "Context before selection:".to_owned(),
        prefix,
        "<selected_text>".to_owned(),
        input.selection.selected_text.clone(),
        "</selected_text>".to_owned(),
        "Context after selection:".to_owned(),
        suffix,
        "Knowledge-base context:".to_owned(),
        retrieved_context,
        "When knowledge-base context supports the answer, cite it using [1], [2], and so on. Do not invent citations.".to_owned(),
    ].join("\n\n");
    let mut messages = Vec::new();
    for turn in input
        .history
        .iter()
        .skip(input.history.len().saturating_sub(6))
    {
        messages.push(WikiIngestLlmMessage {
            role: WikiIngestLlmRole::User,
            content: turn.question.clone(),
        });
        messages.push(WikiIngestLlmMessage {
            role: WikiIngestLlmRole::Assistant,
            content: utf16_suffix(&turn.answer, 6000),
        });
    }
    messages.push(WikiIngestLlmMessage {
        role: WikiIngestLlmRole::User,
        content: prompt,
    });
    WikiIngestLlmRequest {
        model_ref: input.model_ref.clone(),
        messages,
        options: WikiIngestLlmOptions {
            temperature: Some(if input.intent == WikiSelectionIntent::Edit {
                0.2
            } else {
                0.4
            }),
            max_output_tokens: None,
        },
    }
}
