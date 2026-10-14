use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use arrow_array::{
    Array, ArrayRef, FixedSizeListArray, Float32Array, RecordBatch, RecordBatchIterator,
    RecordBatchReader, StringArray, UInt32Array,
};
use arrow_schema::{DataType, Field, Schema};
use chrono::Duration;
use futures_util::TryStreamExt;
use lancedb::{
    connect,
    database::CreateTableMode,
    query::{ExecutableQuery, QueryBase, Select},
    table::{CompactionOptions, OptimizeAction},
};
use sha2::{Digest, Sha256};

const TABLE_CHUNKS_V2: &str = "wiki_chunks_v2";
const EMBEDDING_SPACE: &str = "wiki.embeddingSpace";
const MODEL_CHANGED: &str = "wiki embedding model changed; rebuild the full vector index";
const MAX_PAGE_ID_CHARS: usize = 256;
const REVISION_DIR: &str = ".llm-wiki/embedding-revisions";

static DB_LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::RwLock<()>>>>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct ChunkEmbedding {
    pub chunk_index: u32,
    pub chunk_text: String,
    pub heading_path: String,
    pub embedding: Vec<f32>,
}

#[derive(Debug, Clone)]
pub struct ChunkSearchResult {
    pub chunk_id: String,
    pub page_id: String,
    pub chunk_index: u32,
    pub chunk_text: String,
    pub heading_path: String,
    pub score: f32,
}

pub(crate) struct PageSearchResult {
    pub page_id: String,
    pub score: f32,
    pub chunk_text: String,
    pub heading_path: String,
}

pub(crate) async fn search_pages(
    project_path: &Path,
    embedding: Vec<f32>,
    top_k: usize,
    space_key: &str,
    pages_by_id: &HashMap<String, &crate::domain::SearchPage>,
) -> Result<Vec<PageSearchResult>, String> {
    let chunks = search_chunks(
        project_path,
        embedding,
        top_k.saturating_mul(3).max(30),
        space_key,
    )
    .await?;
    let mut by_page: HashMap<String, Vec<ChunkSearchResult>> = HashMap::new();
    for chunk in chunks {
        by_page
            .entry(chunk.page_id.clone())
            .or_default()
            .push(chunk);
    }
    let mut pages = Vec::with_capacity(by_page.len());
    for (page_id, mut chunks) in by_page {
        chunks.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then(a.chunk_index.cmp(&b.chunk_index))
        });
        let top = chunks[0].score;
        let tail: f32 = chunks.iter().skip(1).map(|chunk| chunk.score).sum();
        let best = chunks.swap_remove(0);
        pages.push(PageSearchResult {
            page_id,
            score: top + (tail * 0.3).min((1.0 - top).max(0.0)),
            chunk_text: best.chunk_text,
            heading_path: best.heading_path,
        });
    }
    pages.sort_unstable_by(|a, b| {
        b.score.total_cmp(&a.score).then_with(|| {
            let path_a = pages_by_id
                .get(&a.page_id)
                .map(|page| page.relative_path.as_str())
                .unwrap_or(&a.page_id);
            let path_b = pages_by_id
                .get(&b.page_id)
                .map(|page| page.relative_path.as_str())
                .unwrap_or(&b.page_id);
            path_a.cmp(path_b)
        })
    });
    pages.truncate(top_k);
    Ok(pages)
}

pub async fn upsert_page_chunks(
    project_path: impl AsRef<Path>,
    page_id: &str,
    chunks: Vec<ChunkEmbedding>,
    fingerprint: &str,
    space_key: &str,
) -> Result<(), String> {
    validate_page_id(page_id)?;
    let project_path = project_path.as_ref();
    let lock = db_lock(project_path);
    let _guard = lock.write().await;

    if chunks.is_empty() {
        return Ok(());
    }
    if fingerprint.trim().is_empty() {
        return Err("embedding revision fingerprint is required".to_string());
    }

    let dim = i32::try_from(chunks[0].embedding.len())
        .map_err(|_| "embedding dimension is too large".to_owned())?;
    if dim == 0 {
        return Err("chunk #0 has empty embedding".to_string());
    }

    let schema = chunk_schema(dim, space_key)?;
    let batch = chunk_batch(schema.clone(), page_id, chunks, dim)?;
    let revision = CachedRevision {
        fingerprint: fingerprint.to_owned(),
        rows_signature: Some(rows_signature(std::slice::from_ref(&batch))?),
    };
    let db = connect(&db_uri(project_path))
        .execute()
        .await
        .map_err(|err| format!("DB connect error: {err}"))?;

    invalidate_revision_unlocked(project_path, page_id)?;
    upsert_batch(&db, page_id, batch, schema).await?;
    save_revision_unlocked(project_path, page_id, &revision)
}

async fn upsert_batch(
    db: &lancedb::Connection,
    page_id: &str,
    batch: RecordBatch,
    schema: Arc<Schema>,
) -> Result<(), String> {
    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|err| format!("List tables error: {err}"))?;
    if has_table(&tables, TABLE_CHUNKS_V2) {
        let table = db
            .open_table(TABLE_CHUNKS_V2)
            .execute()
            .await
            .map_err(|err| format!("Open table error: {err}"))?;
        let stored_schema = table
            .schema()
            .await
            .map_err(|err| format!("Read schema error: {err}"))?;
        check_embedding_space(&stored_schema, &schema.metadata()[EMBEDDING_SPACE], None)?;
        if stored_schema.fields() != schema.fields() {
            return Err(MODEL_CHANGED.to_owned());
        }
        let data = RecordBatchIterator::new(vec![Ok(batch)], schema);
        let mut merge = table.merge_insert(&["chunk_id"]);
        merge
            .when_matched_update_all(None)
            .when_not_matched_insert_all()
            .when_not_matched_by_source_delete(Some(page_id_filter(page_id)));
        merge
            .execute(Box::new(data))
            .await
            .map_err(|err| format!("Atomic page upsert failed: {err}"))?;
    } else {
        let data: Box<dyn RecordBatchReader + Send> =
            Box::new(RecordBatchIterator::new(vec![Ok(batch)], schema));
        db.create_table(TABLE_CHUNKS_V2, data)
            .execute()
            .await
            .map_err(|err| format!("Create table error: {err}"))?;
    }
    Ok(())
}

fn prepare_batches(
    pages: Vec<crate::index::PreparedPageEmbedding>,
) -> Result<(Arc<Schema>, Vec<(String, CachedRevision, RecordBatch)>), String> {
    if pages.is_empty() {
        return Ok((Arc::new(Schema::empty()), Vec::new()));
    }
    let space_key = pages[0].space_key.clone();
    let dimension = pages
        .first()
        .and_then(|page| page.rows.first())
        .map(|row| row.embedding.len())
        .unwrap_or(1);
    let dimension =
        i32::try_from(dimension).map_err(|_| "embedding dimension is too large".to_owned())?;
    if dimension == 0 {
        return Err("embedding dimension is empty".to_owned());
    }
    let schema = chunk_schema(dimension, &space_key)?;
    let mut batches = Vec::with_capacity(pages.len());
    for page in pages {
        if page.space_key != space_key {
            return Err(MODEL_CHANGED.to_owned());
        }
        validate_page_id(&page.page_id)?;
        if page.rows.is_empty() || page.fingerprint.trim().is_empty() {
            return Err("prepared page has no chunks or revision fingerprint".to_owned());
        }
        let batch = chunk_batch(schema.clone(), &page.page_id, page.rows, dimension)?;
        let revision = CachedRevision {
            fingerprint: page.fingerprint,
            rows_signature: Some(rows_signature(std::slice::from_ref(&batch))?),
        };
        batches.push((page.page_id, revision, batch));
    }
    Ok((schema, batches))
}

pub(crate) async fn replace_pages(
    project_path: &Path,
    pages: Vec<crate::index::PreparedPageEmbedding>,
) -> Result<usize, String> {
    let (schema, prepared) = prepare_batches(pages)?;
    let lock = db_lock(project_path);
    let _guard = lock.write().await;
    let db = connect(&db_uri(project_path))
        .execute()
        .await
        .map_err(|err| format!("DB connect error: {err}"))?;
    if prepared.is_empty() {
        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|err| format!("List tables error: {err}"))?;
        if has_table(&tables, TABLE_CHUNKS_V2) {
            let count = db
                .open_table(TABLE_CHUNKS_V2)
                .execute()
                .await
                .map_err(|err| format!("Open table error: {err}"))?
                .count_rows(None)
                .await
                .map_err(|err| format!("Count chunks error: {err}"))?;
            if count > 0 {
                return Err(
                    "wiki has no indexable content; existing index was left unchanged".to_owned(),
                );
            }
        }
        return Ok(0);
    }
    // Revision files are a cache; invalidate before the single Lance commit so no stale fast-skip survives it.
    invalidate_all_revisions_unlocked(project_path)?;
    let count = prepared.len();
    let batches = prepared
        .iter()
        .map(|(_, _, batch)| batch.clone())
        .collect::<Vec<_>>();
    let data: Box<dyn RecordBatchReader + Send> = Box::new(RecordBatchIterator::new(
        batches.into_iter().map(Ok),
        schema,
    ));
    db.create_table(TABLE_CHUNKS_V2, data)
        .mode(CreateTableMode::Overwrite)
        .execute()
        .await
        .map_err(|err| format!("Atomic index replacement failed: {err}"))?;
    for (page_id, revision, _) in prepared {
        let _ = save_revision_unlocked(project_path, &page_id, &revision);
    }
    Ok(count)
}

pub(crate) async fn update_pages(
    project_path: &Path,
    pages: Vec<crate::index::PreparedPageEmbedding>,
    on_written: &(dyn Fn(usize) + Send + Sync),
) -> (usize, Option<String>) {
    let (schema, prepared) = match prepare_batches(pages) {
        Ok(prepared) => prepared,
        Err(error) => return (0, Some(error)),
    };
    if prepared.is_empty() {
        return (0, None);
    }
    let lock = db_lock(project_path);
    let _guard = lock.write().await;
    let db = match connect(&db_uri(project_path)).execute().await {
        Ok(db) => db,
        Err(error) => return (0, Some(format!("DB connect error: {error}"))),
    };
    let compatible = async {
        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|err| format!("List tables error: {err}"))?;
        if has_table(&tables, TABLE_CHUNKS_V2) {
            let table = db
                .open_table(TABLE_CHUNKS_V2)
                .execute()
                .await
                .map_err(|err| format!("Open table error: {err}"))?;
            let stored_schema = table
                .schema()
                .await
                .map_err(|err| format!("Read schema error: {err}"))?;
            check_embedding_space(&stored_schema, &schema.metadata()[EMBEDDING_SPACE], None)?;
            if stored_schema.fields() != schema.fields() {
                return Err(MODEL_CHANGED.to_owned());
            }
        }
        Ok(())
    }
    .await;
    if let Err(error) = compatible {
        return (0, Some(error));
    }
    let mut count = 0;
    let mut failure = None;
    for (page_id, revision, batch) in prepared {
        if let Err(error) = invalidate_revision_unlocked(project_path, &page_id) {
            failure.get_or_insert(error);
            continue;
        }
        match upsert_batch(&db, &page_id, batch, schema.clone()).await {
            Ok(()) => {
                count += 1;
                on_written(count);
                let _ = save_revision_unlocked(project_path, &page_id, &revision);
            }
            Err(error) => {
                failure.get_or_insert(error);
            }
        }
    }
    (count, failure)
}

pub async fn search_chunks(
    project_path: impl AsRef<Path>,
    embedding: Vec<f32>,
    top_k: usize,
    space_key: &str,
) -> Result<Vec<ChunkSearchResult>, String> {
    if top_k == 0 {
        return Ok(Vec::new());
    }
    if embedding.is_empty() {
        return Err("query embedding is empty".to_string());
    }
    let project_path = project_path.as_ref();
    let lock = db_lock(project_path);
    let _guard = lock.read().await;

    let db = connect(&db_uri(project_path))
        .execute()
        .await
        .map_err(|err| format!("DB connect error: {err}"))?;
    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|err| format!("List tables error: {err}"))?;
    if !has_table(&tables, TABLE_CHUNKS_V2) {
        return Ok(Vec::new());
    }

    let table = db
        .open_table(TABLE_CHUNKS_V2)
        .execute()
        .await
        .map_err(|err| format!("Open table error: {err}"))?;
    let schema = table
        .schema()
        .await
        .map_err(|err| format!("Read schema error: {err}"))?;
    check_embedding_space(&schema, space_key, Some(embedding.len()))?;
    let stream = table
        .vector_search(embedding)
        .map_err(|err| format!("Search error: {err}"))?
        .limit(top_k)
        .execute()
        .await
        .map_err(|err| format!("Execute search error: {err}"))?;
    let batches: Vec<RecordBatch> = stream
        .try_collect()
        .await
        .map_err(|err| format!("Collect error: {err}"))?;

    let mut out = Vec::new();
    for batch in &batches {
        let chunk_ids = string_column(batch, "chunk_id")?;
        let page_ids = string_column(batch, "page_id")?;
        let chunk_indexes = batch
            .column_by_name("chunk_index")
            .and_then(|column| column.as_any().downcast_ref::<UInt32Array>())
            .ok_or_else(|| "Missing chunk_index column".to_string())?;
        let chunk_texts = string_column(batch, "chunk_text")?;
        let heading_paths = string_column(batch, "heading_path")?;
        let distances = batch
            .column_by_name("_distance")
            .and_then(|column| column.as_any().downcast_ref::<Float32Array>())
            .ok_or_else(|| "Missing _distance column".to_string())?;

        for index in 0..batch.num_rows() {
            let distance = distances.value(index);
            out.push(ChunkSearchResult {
                chunk_id: chunk_ids.value(index).to_string(),
                page_id: page_ids.value(index).to_string(),
                chunk_index: chunk_indexes.value(index),
                chunk_text: chunk_texts.value(index).to_string(),
                heading_path: heading_paths.value(index).to_string(),
                score: 1.0 / (1.0 + distance),
            });
        }
    }

    Ok(out)
}

pub async fn delete_page(project_path: impl AsRef<Path>, page_id: &str) -> Result<(), String> {
    validate_page_id(page_id)?;
    let project_path = project_path.as_ref();
    let lock = db_lock(project_path);
    let _guard = lock.write().await;

    let db = connect(&db_uri(project_path))
        .execute()
        .await
        .map_err(|err| format!("DB connect error: {err}"))?;
    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|err| format!("List tables error: {err}"))?;
    invalidate_revision_unlocked(project_path, page_id)?;
    if has_table(&tables, TABLE_CHUNKS_V2) {
        db.open_table(TABLE_CHUNKS_V2)
            .execute()
            .await
            .map_err(|err| format!("Open table error: {err}"))?
            .delete(&page_id_filter(page_id))
            .await
            .map_err(|err| format!("Delete error: {err}"))?;
    }
    Ok(())
}

pub async fn count_chunks(project_path: impl AsRef<Path>) -> Result<usize, String> {
    let project_path = project_path.as_ref();
    let lock = db_lock(project_path);
    let _guard = lock.read().await;

    let db = connect(&db_uri(project_path))
        .execute()
        .await
        .map_err(|err| format!("DB connect error: {err}"))?;
    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|err| format!("List tables error: {err}"))?;
    if !has_table(&tables, TABLE_CHUNKS_V2) {
        return Ok(0);
    }
    db.open_table(TABLE_CHUNKS_V2)
        .execute()
        .await
        .map_err(|err| format!("Open table error: {err}"))?
        .count_rows(None)
        .await
        .map_err(|err| format!("Count error: {err}"))
}

pub async fn clear(project_path: impl AsRef<Path>) -> Result<(), String> {
    let project_path = project_path.as_ref();
    let lock = db_lock(project_path);
    let _guard = lock.write().await;

    let db = connect(&db_uri(project_path))
        .execute()
        .await
        .map_err(|err| format!("DB connect error: {err}"))?;
    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|err| format!("List tables error: {err}"))?;
    invalidate_all_revisions_unlocked(project_path)?;
    if has_table(&tables, TABLE_CHUNKS_V2) {
        db.drop_table(TABLE_CHUNKS_V2, &[])
            .await
            .map_err(|err| format!("Drop chunk table error: {err}"))?;
    }
    Ok(())
}

pub async fn optimize(project_path: impl AsRef<Path>) -> Result<(), String> {
    let project_path = project_path.as_ref();
    let lock = db_lock(project_path);
    let _guard = lock.write().await;

    let db = connect(&db_uri(project_path))
        .execute()
        .await
        .map_err(|err| format!("DB connect error: {err}"))?;
    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|err| format!("List tables error: {err}"))?;
    if !has_table(&tables, TABLE_CHUNKS_V2) {
        return Ok(());
    }
    let table = db
        .open_table(TABLE_CHUNKS_V2)
        .execute()
        .await
        .map_err(|err| format!("Open table error: {err}"))?;
    table
        .optimize(OptimizeAction::Compact {
            options: CompactionOptions::default(),
            remap_options: None,
        })
        .await
        .map_err(|err| format!("Compact chunks error: {err}"))?;
    table
        .optimize(OptimizeAction::Prune {
            older_than: Some(Duration::try_seconds(0).expect("valid duration")),
            delete_unverified: Some(false),
            error_if_tagged_old_versions: Some(false),
        })
        .await
        .map_err(|err| format!("Prune old chunk versions error: {err}"))?;
    Ok(())
}

pub(crate) async fn page_revision_matches(
    project_path: &Path,
    page_id: &str,
    fingerprint: &str,
    space_key: &str,
) -> Result<bool, String> {
    validate_page_id(page_id)?;
    let lock = db_lock(project_path);
    let _guard = lock.read().await;
    let db = connect(&db_uri(project_path))
        .execute()
        .await
        .map_err(|err| format!("DB connect error: {err}"))?;
    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|err| format!("List tables error: {err}"))?;
    if !has_table(&tables, TABLE_CHUNKS_V2) {
        return Ok(false);
    }
    let table = db
        .open_table(TABLE_CHUNKS_V2)
        .execute()
        .await
        .map_err(|err| format!("Open table error: {err}"))?;
    let schema = table
        .schema()
        .await
        .map_err(|err| format!("Read schema error: {err}"))?;
    check_embedding_space(&schema, space_key, None)?;
    let Some(revision) = load_revision_unlocked(project_path, page_id)? else {
        return Ok(false);
    };
    if revision.fingerprint != fingerprint {
        return Ok(false);
    }
    let Some(stored_signature) = revision.rows_signature else {
        return Ok(false);
    };
    let batches = page_batches(&table, page_id).await?;
    Ok(batches.iter().any(|batch| batch.num_rows() > 0)
        && rows_signature(&batches)? == stored_signature)
}

pub async fn load_revision(
    project_path: impl AsRef<Path>,
    page_id: &str,
) -> Result<Option<String>, String> {
    validate_page_id(page_id)?;
    let project_path = project_path.as_ref();
    let lock = db_lock(project_path);
    let _guard = lock.read().await;
    Ok(load_revision_unlocked(project_path, page_id)?.map(|revision| revision.fingerprint))
}

pub async fn save_revision(
    project_path: impl AsRef<Path>,
    page_id: &str,
    fingerprint: &str,
) -> Result<(), String> {
    validate_page_id(page_id)?;
    if fingerprint.trim().is_empty() {
        return Err("embedding revision fingerprint is required".to_string());
    }
    let project_path = project_path.as_ref();
    let lock = db_lock(project_path);
    let _guard = lock.write().await;
    let revision = CachedRevision {
        fingerprint: fingerprint.to_owned(),
        rows_signature: None,
    };
    save_revision_unlocked(project_path, page_id, &revision)
}

pub async fn invalidate_revision(
    project_path: impl AsRef<Path>,
    page_id: &str,
) -> Result<(), String> {
    validate_page_id(page_id)?;
    let project_path = project_path.as_ref();
    let lock = db_lock(project_path);
    let _guard = lock.write().await;
    invalidate_revision_unlocked(project_path, page_id)
}

pub fn validate_page_id(page_id: &str) -> Result<(), String> {
    if page_id.is_empty() {
        return Err("Invalid page_id: empty or too long".to_string());
    }

    let mut char_count = 0usize;
    for character in page_id.chars() {
        char_count += 1;
        if char_count > MAX_PAGE_ID_CHARS {
            return Err("Invalid page_id: empty or too long".to_string());
        }
        if is_disallowed_page_id_char(character) {
            return Err(format!(
                "Invalid page_id: contains disallowed character {character:?}: {page_id}"
            ));
        }
    }
    Ok(())
}

fn db_uri(project_path: &Path) -> String {
    project_path
        .join(".llm-wiki")
        .join("lancedb")
        .to_string_lossy()
        .replace('\\', "/")
}

fn db_lock(project_path: &Path) -> Arc<tokio::sync::RwLock<()>> {
    let key = db_uri(project_path);
    let locks = DB_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().expect("wiki vector lock map poisoned");
    locks
        .entry(key)
        .or_insert_with(|| Arc::new(tokio::sync::RwLock::new(())))
        .clone()
}

fn has_table(table_names: &[String], table_name: &str) -> bool {
    table_names.iter().any(|name| name == table_name)
}

fn check_embedding_space(
    schema: &Schema,
    space_key: &str,
    dimension: Option<usize>,
) -> Result<(), String> {
    if space_key.is_empty()
        || schema.metadata().get(EMBEDDING_SPACE).map(String::as_str) != Some(space_key)
    {
        return Err(MODEL_CHANGED.to_owned());
    }
    if let Some(dimension) = dimension {
        let compatible = schema.field_with_name("vector").is_ok_and(|field| {
            matches!(field.data_type(), DataType::FixedSizeList(_, size) if usize::try_from(*size).ok() == Some(dimension))
        });
        if !compatible {
            return Err(MODEL_CHANGED.to_owned());
        }
    }
    Ok(())
}

fn chunk_schema(dim: i32, space_key: &str) -> Result<Arc<Schema>, String> {
    if space_key.is_empty() {
        return Err("embedding space key is required".to_owned());
    }
    Ok(Arc::new(Schema::new_with_metadata(
        vec![
            Field::new("chunk_id", DataType::Utf8, false),
            Field::new("page_id", DataType::Utf8, false),
            Field::new("chunk_index", DataType::UInt32, false),
            Field::new("chunk_text", DataType::Utf8, false),
            Field::new("heading_path", DataType::Utf8, false),
            Field::new(
                "vector",
                DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), dim),
                false,
            ),
        ],
        HashMap::from([(EMBEDDING_SPACE.to_owned(), space_key.to_owned())]),
    )))
}

fn chunk_batch(
    schema: Arc<Schema>,
    page_id: &str,
    chunks: Vec<ChunkEmbedding>,
    dim: i32,
) -> Result<RecordBatch, String> {
    let dim_usize = dim as usize;
    let mut chunk_ids = Vec::with_capacity(chunks.len());
    let mut page_ids = Vec::with_capacity(chunks.len());
    let mut indexes = Vec::with_capacity(chunks.len());
    let mut texts = Vec::with_capacity(chunks.len());
    let mut heading_paths = Vec::with_capacity(chunks.len());
    let mut flat_vectors = Vec::with_capacity(chunks.len() * dim_usize);

    for chunk in chunks {
        if chunk.embedding.len() != dim_usize {
            return Err(format!(
                "chunk #{} has embedding dim {} but batch dim is {}",
                chunk.chunk_index,
                chunk.embedding.len(),
                dim
            ));
        }
        chunk_ids.push(format!("{}#{}", page_id, chunk.chunk_index));
        page_ids.push(page_id.to_string());
        indexes.push(chunk.chunk_index);
        texts.push(chunk.chunk_text);
        heading_paths.push(chunk.heading_path);
        flat_vectors.extend(chunk.embedding);
    }

    let values = Float32Array::from(flat_vectors);
    let vector: ArrayRef = Arc::new(FixedSizeListArray::new(
        Arc::new(Field::new("item", DataType::Float32, true)),
        dim,
        Arc::new(values),
        None,
    ));

    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(StringArray::from(chunk_ids)),
            Arc::new(StringArray::from(page_ids)),
            Arc::new(UInt32Array::from(indexes)),
            Arc::new(StringArray::from(texts)),
            Arc::new(StringArray::from(heading_paths)),
            vector,
        ],
    )
    .map_err(|err| format!("Batch error: {err}"))
}

fn string_column<'a>(batch: &'a RecordBatch, name: &str) -> Result<&'a StringArray, String> {
    batch
        .column_by_name(name)
        .and_then(|column| column.as_any().downcast_ref::<StringArray>())
        .ok_or_else(|| format!("Missing {name} column"))
}

fn page_id_filter(page_id: &str) -> String {
    format!("page_id = '{page_id}'")
}

fn revision_path(project_path: &Path, page_id: &str) -> PathBuf {
    let key = format!("{:x}", Sha256::digest(page_id.as_bytes()));
    project_path
        .join(REVISION_DIR)
        .join(format!("{key}.revision"))
}

async fn page_batches(table: &lancedb::Table, page_id: &str) -> Result<Vec<RecordBatch>, String> {
    table
        .query()
        .only_if(page_id_filter(page_id))
        .select(Select::columns(&[
            "chunk_id", "page_id", "chunk_index", "chunk_text", "heading_path", "vector",
        ]))
        .execute()
        .await
        .map_err(|err| format!("Read page chunks error: {err}"))?
        .try_collect()
        .await
        .map_err(|err| format!("Collect page chunks error: {err}"))
}

// Physical row/batch order can change on compaction; chunk_index and every stored value must not.
fn rows_signature(batches: &[RecordBatch]) -> Result<String, String> {
    let mut rows = Vec::new();
    for batch in batches {
        let strings = [
            string_column(batch, "chunk_id")?,
            string_column(batch, "page_id")?,
            string_column(batch, "chunk_text")?,
            string_column(batch, "heading_path")?,
        ];
        let indexes = batch
            .column_by_name("chunk_index")
            .and_then(|column| column.as_any().downcast_ref::<UInt32Array>())
            .ok_or_else(|| "Missing chunk_index column".to_owned())?;
        let vectors = batch
            .column_by_name("vector")
            .and_then(|column| column.as_any().downcast_ref::<FixedSizeListArray>())
            .ok_or_else(|| "Missing vector column".to_owned())?;
        let values = vectors
            .values()
            .as_any()
            .downcast_ref::<Float32Array>()
            .ok_or_else(|| "Invalid vector values".to_owned())?;
        for index in 0..batch.num_rows() {
            let mut signature = Sha256::new();
            for column in strings {
                let text = column.value(index).as_bytes();
                signature.update([u8::from(column.is_valid(index))]);
                signature.update((text.len() as u64).to_le_bytes());
                signature.update(text);
            }
            signature.update([u8::from(indexes.is_valid(index))]);
            signature.update(indexes.value(index).to_le_bytes());
            signature.update([u8::from(vectors.is_valid(index))]);
            signature.update(vectors.value_length().to_le_bytes());
            let offset = vectors.value_offset(index) as usize;
            for index in offset..offset + vectors.value_length() as usize {
                signature.update([u8::from(values.is_valid(index))]);
                signature.update(values.value(index).to_bits().to_le_bytes());
            }
            let signature: [u8; 32] = signature.finalize().into();
            rows.push((indexes.value(index), signature));
        }
    }
    rows.sort_unstable();
    let mut signature = Sha256::new();
    signature.update((rows.len() as u64).to_le_bytes());
    for (_, row) in rows {
        signature.update(row);
    }
    Ok(format!("{:x}", signature.finalize()))
}

struct CachedRevision {
    fingerprint: String,
    rows_signature: Option<String>,
}

fn load_revision_unlocked(
    project_path: &Path,
    page_id: &str,
) -> Result<Option<CachedRevision>, String> {
    let value = match fs::read_to_string(revision_path(project_path, page_id)) {
        Ok(value) => value,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Failed to read embedding revision: {err}")),
    };
    let Some((rows_signature, fingerprint)) = value.split_once('\n') else {
        return Ok(None);
    };
    let fingerprint = fingerprint.trim();
    if fingerprint.is_empty()
        || (!rows_signature.is_empty()
            && (rows_signature.len() != 64
                || !rows_signature.bytes().all(|byte| byte.is_ascii_hexdigit())))
    {
        return Ok(None);
    }
    Ok(Some(CachedRevision {
        fingerprint: fingerprint.to_owned(),
        rows_signature: (!rows_signature.is_empty()).then(|| rows_signature.to_owned()),
    }))
}

fn save_revision_unlocked(
    project_path: &Path,
    page_id: &str,
    revision: &CachedRevision,
) -> Result<(), String> {
    let value = format!(
        "{}\n{}",
        revision.rows_signature.as_deref().unwrap_or_default(),
        revision.fingerprint,
    );
    crate::history::replace_store(&revision_path(project_path, page_id), value.as_bytes())
        .map_err(|error| match error {
            crate::WikiFailure::Io { message, .. }
            | crate::WikiFailure::StateUnavailable { message } => {
                format!("Failed to save embedding revision: {message}")
            }
            _ => "Failed to save embedding revision".to_owned(),
        })
}

fn invalidate_revision_unlocked(project_path: &Path, page_id: &str) -> Result<(), String> {
    match fs::remove_file(revision_path(project_path, page_id)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Failed to invalidate embedding revision: {err}")),
    }
}

fn invalidate_all_revisions_unlocked(project_path: &Path) -> Result<(), String> {
    match fs::remove_dir_all(project_path.join(REVISION_DIR)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Failed to invalidate embedding revisions: {err}")),
    }
}

fn is_disallowed_page_id_char(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '/' | '\\'
                | '\''
                | '"'
                | '\u{00AD}'
                | '\u{061C}'
                | '\u{200B}'..='\u{200F}'
                | '\u{2028}'..='\u{202E}'
                | '\u{2060}'..='\u{206F}'
                | '\u{FEFF}'
                | '\u{FFF9}'..='\u{FFFB}'
                | '\u{E0000}'..='\u{E007F}'
        )
}
