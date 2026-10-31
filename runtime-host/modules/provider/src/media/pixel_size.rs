use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    step: u32,
    max_edge: u32,
    min_pixels: u32,
    max_pixels: u32,
    max_aspect_ratio: u32,
    experimental_above_pixels: u32,
}

const GPT_IMAGE_LIMITS: Limits = Limits {
    step: 16,
    max_edge: 3840,
    min_pixels: 655_360,
    max_pixels: 8_294_400,
    max_aspect_ratio: 3,
    experimental_above_pixels: 3_686_400,
};

pub(super) fn for_model(model_id: &str) -> Option<Limits> {
    matches!(
        model_id,
        "gpt-image-2"
            | "gpt-image-2-2026-04-21"
            | "gpt-image-2.5-sunburst"
            | "gpt-image-2.5-sunburst-2026-09-08"
            | "gpt-image-2.5-flare"
            | "gpt-image-2.5-flare-2026-09-08"
    )
    .then_some(GPT_IMAGE_LIMITS)
}

impl Limits {
    pub(super) fn supports(&self, size: &str) -> bool {
        let Some((width, height)) = size.split_once('x') else {
            return false;
        };
        if width.starts_with('0')
            || height.starts_with('0')
            || !width
                .bytes()
                .chain(height.bytes())
                .all(|byte| byte.is_ascii_digit())
        {
            return false;
        }
        let (Ok(width), Ok(height)) = (width.parse::<u32>(), height.parse::<u32>()) else {
            return false;
        };
        let pixels = u64::from(width) * u64::from(height);
        width <= self.max_edge
            && height <= self.max_edge
            && width % self.step == 0
            && height % self.step == 0
            && pixels >= u64::from(self.min_pixels)
            && pixels <= u64::from(self.max_pixels)
            && width.max(height) <= width.min(height) * self.max_aspect_ratio
    }
}
