use std::fmt;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MemberId(String);

impl MemberId {
    /// Creates an Organization member identity.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidMemberId`] when `value` is empty or contains only whitespace.
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidMemberId> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidMemberId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidMemberId;

impl fmt::Display for InvalidMemberId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("member ID must not be empty")
    }
}

impl std::error::Error for InvalidMemberId {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamMember {
    member_id: MemberId,
    name: String,
}

impl TeamMember {
    /// Creates a reusable Team member without binding it to a Runtime agent.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidMemberName`] when `name` is empty or contains only whitespace.
    pub fn try_new(
        member_id: MemberId,
        name: impl Into<String>,
    ) -> Result<Self, InvalidMemberName> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(InvalidMemberName);
        }
        Ok(Self { member_id, name })
    }

    pub fn member_id(&self) -> &MemberId {
        &self.member_id
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidMemberName;

impl fmt::Display for InvalidMemberName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("team member name must not be empty")
    }
}

impl std::error::Error for InvalidMemberName {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_keeps_organization_identity_and_name_without_runtime_binding() {
        let member = TeamMember::try_new(
            MemberId::try_new("member:researcher").unwrap(),
            "Researcher",
        )
        .unwrap();

        assert_eq!(member.member_id().as_str(), "member:researcher");
        assert_eq!(member.name(), "Researcher");
    }

    #[test]
    fn member_facts_reject_empty_identifiers_and_names_without_exposing_input() {
        let identity_error = MemberId::try_new(" \t\n").unwrap_err();
        let name_error =
            TeamMember::try_new(MemberId::try_new("member:researcher").unwrap(), "\u{2003}")
                .unwrap_err();

        assert_eq!(identity_error, InvalidMemberId);
        assert_eq!(identity_error.to_string(), "member ID must not be empty");
        assert_eq!(name_error, InvalidMemberName);
        assert_eq!(name_error.to_string(), "team member name must not be empty");
    }
}
