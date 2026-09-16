pub(crate) fn capability_for(value: &str) -> Option<environment::ProviderModelCapability> {
    match value {
        "chat" => Some(environment::ProviderModelCapability::Chat),
        "imageUnderstand" => Some(environment::ProviderModelCapability::ImageUnderstand),
        "imageGenerate" => Some(environment::ProviderModelCapability::ImageGenerate),
        "videoGenerate" => Some(environment::ProviderModelCapability::VideoGenerate),
        "musicGenerate" => Some(environment::ProviderModelCapability::MusicGenerate),
        "tts" => Some(environment::ProviderModelCapability::TextToSpeech),
        "transcribe" => Some(environment::ProviderModelCapability::Transcribe),
        _ => None,
    }
}
