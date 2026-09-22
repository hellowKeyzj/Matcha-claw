use std::collections::BTreeMap;

use crate::projection::subagent_templates as projection;

pub trait CatalogTarget {
    type Catalog;
    type Category;
    type Summary;

    fn catalog(categories: Vec<Self::Category>, templates: Vec<Self::Summary>) -> Self::Catalog;
    fn category(id: String, order: Option<i64>) -> Self::Category;
    fn summary(
        id: String,
        name: String,
        summary: Option<String>,
        category_id: Option<String>,
        subcategory_id: Option<String>,
        order: Option<i64>,
        files: Vec<String>,
    ) -> Self::Summary;
}

pub trait DetailTarget: CatalogTarget {
    type Detail;
    type Template;

    fn detail(template: Self::Template) -> Self::Detail;
    fn template(summary: Self::Summary, file_contents: BTreeMap<String, String>) -> Self::Template;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Unavailable,
    NotFound,
}

pub fn project_error(error: projection::SubagentTemplateError) -> Error {
    match error {
        projection::SubagentTemplateError::Unavailable => Error::Unavailable,
        projection::SubagentTemplateError::NotFound => Error::NotFound,
    }
}

pub fn project_catalog<T: CatalogTarget>(catalog: projection::Catalog) -> T::Catalog {
    T::catalog(
        catalog
            .categories()
            .iter()
            .map(project_category::<T>)
            .collect(),
        catalog
            .templates()
            .iter()
            .map(project_summary::<T>)
            .collect(),
    )
}

pub fn project_detail<T: DetailTarget>(detail: projection::Detail) -> T::Detail {
    T::detail(project_template::<T>(detail.template()))
}

fn project_category<T: CatalogTarget>(category: &projection::Category) -> T::Category {
    T::category(category.id().to_owned(), category.order())
}

fn project_summary<T: CatalogTarget>(summary: &projection::Summary) -> T::Summary {
    T::summary(
        summary.id().to_owned(),
        summary.name().to_owned(),
        summary.summary().map(str::to_owned),
        summary.category_id().map(str::to_owned),
        summary.subcategory_id().map(str::to_owned),
        summary.order(),
        summary
            .files()
            .iter()
            .map(|file| file.public_name().to_owned())
            .collect(),
    )
}

fn project_template<T: DetailTarget>(template: &projection::Template) -> T::Template {
    T::template(
        project_summary::<T>(template.summary()),
        template
            .file_contents()
            .iter()
            .map(|(file, content)| (file.public_name().to_owned(), content.clone()))
            .collect(),
    )
}
