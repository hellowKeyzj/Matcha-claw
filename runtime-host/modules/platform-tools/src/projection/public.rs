use serde_json::Value;

use crate::{PlatformTool, PlatformToolsOutcome};

pub enum Delivery {
    Ok(Vec<PlatformTool>),
    Unavailable,
}

impl Delivery {
    pub fn status_code(&self) -> u16 {
        match self {
            Self::Ok(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub fn body(&self) -> Value {
        match self {
            Self::Ok(tools) => serde_json::json!({ "success": true, "tools": tools }),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Platform tools catalog is unavailable",
            }),
        }
    }
}

impl From<PlatformToolsOutcome> for Delivery {
    fn from(value: PlatformToolsOutcome) -> Self {
        match value {
            PlatformToolsOutcome::Tools(tools) => Self::Ok(tools),
            PlatformToolsOutcome::Unavailable => Self::Unavailable,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_response_is_fixed_and_redacted() {
        let delivery = Delivery::from(PlatformToolsOutcome::Unavailable);

        assert_eq!(delivery.status_code(), 503);
        assert_eq!(
            delivery.body(),
            serde_json::json!({
                "success": false,
                "error": "Platform tools catalog is unavailable"
            })
        );
    }

    #[test]
    fn tools_response_projects_only_public_fields() {
        let delivery = Delivery::from(PlatformToolsOutcome::Tools(vec![PlatformTool::new(
            "bash".into(),
            "Bash".into(),
            "core".into(),
            true,
            Some("Shell command".into()),
            None,
        )]));

        assert_eq!(delivery.status_code(), 200);
        assert_eq!(
            delivery.body(),
            serde_json::json!({
                "success": true,
                "tools": [{
                    "id": "bash",
                    "name": "Bash",
                    "source": "core",
                    "enabled": true,
                    "description": "Shell command"
                }]
            })
        );
    }
}
