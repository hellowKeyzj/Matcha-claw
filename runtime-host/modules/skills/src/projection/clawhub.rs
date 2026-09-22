use crate::ports::ClawHubSearchResult;

pub fn project_search_result(
    slug: &str,
    name: &str,
    description: &str,
    version: &str,
    author: Option<&str>,
    downloads: Option<u64>,
    stars: Option<u64>,
) -> ClawHubSearchResult {
    ClawHubSearchResult::new(
        slug.to_owned(),
        name.to_owned(),
        description.to_owned(),
        version.to_owned(),
        author.map(str::to_owned),
        downloads,
        stars,
    )
}
