use std::collections::BTreeMap;
use std::io::Cursor;

use calamine::{Data, Reader, Sheets};

use crate::{
    Anchor, BlockKind, Cell, CellValue, CoverageReason, CoverageStatus, Document, FailureKind,
    ParseFailure, ParseRequest, SourceMapEntry, Table, Target, archive,
};

type RawCells = BTreeMap<(String, u32, u32), RawCell>;
#[derive(Default)]
struct RawCell {
    raw: Option<String>,
    formula: Option<String>,
    value: Option<CellValue>,
    row_span: u32,
    column_span: u32,
}

fn workbook<'a>(
    bytes: &'a [u8],
    extension: &str,
) -> Result<Sheets<Cursor<&'a [u8]>>, ParseFailure> {
    let cursor = Cursor::new(bytes);
    match extension {
        "xls" => calamine::Xls::new(cursor)
            .map(Sheets::Xls)
            .map_err(calamine::Error::Xls),
        "xlsb" => calamine::Xlsb::new(cursor)
            .map(Sheets::Xlsb)
            .map_err(calamine::Error::Xlsb),
        "ods" => calamine::Ods::new(cursor)
            .map(Sheets::Ods)
            .map_err(calamine::Error::Ods),
        _ => calamine::Xlsx::new(cursor)
            .map(Sheets::Xlsx)
            .map_err(calamine::Error::Xlsx),
    }
    .map_err(sheet_error)
}

fn sheet_error(error: calamine::Error) -> ParseFailure {
    let kind = match &error {
        calamine::Error::Xls(calamine::XlsError::Password)
        | calamine::Error::Xlsb(calamine::XlsbError::Password)
        | calamine::Error::Xlsx(calamine::XlsxError::Password)
        | calamine::Error::Ods(calamine::OdsError::Password) => FailureKind::Encrypted,
        _ => FailureKind::Corrupt,
    };
    ParseFailure::caused(kind, error)
}

pub(crate) fn parse(request: &ParseRequest<'_>, extension: &str) -> Result<Document, ParseFailure> {
    // AnyDoc detects encrypted OLE containers before calamine's format-specific open.
    let mut output = Document::default();
    output.markdown =
        crate::office_markdown::extract_office_text(request.bytes, extension, &mut output)?;
    let mut workbook = workbook(request.bytes, extension)?;
    let names = workbook.sheet_names().to_vec();
    let mut raw = if matches!(extension, "xlsx" | "xlsm") {
        xlsx_raw(request.bytes)?
    } else if extension == "ods" {
        ods_raw(request.bytes)?
    } else {
        BTreeMap::new()
    };
    for name in names {
        request.check_cancelled()?;
        let anchor = Anchor::Sheet {
            sheet: name.clone(),
            row: 1,
            column: 1,
        };
        let range = match workbook.worksheet_range(&name) {
            Ok(range) => range,
            Err(error) => {
                let failure = sheet_error(error);
                if failure.kind == FailureKind::Encrypted {
                    return Err(failure);
                }
                output.diagnostics.push(failure);
                output.coverage(
                    Some(anchor),
                    CoverageStatus::Failed,
                    CoverageReason::SheetReadFailed,
                );
                continue;
            }
        };
        if range.get_size().0.saturating_mul(range.get_size().1) > 1_000_000 {
            return Err(ParseFailure::limit("table_cells"));
        }
        let formulas = workbook.worksheet_formula(&name);
        let formulas = match formulas {
            Ok(range) => Some(range),
            Err(error) => {
                output.diagnostics.push(sheet_error(error));
                output.coverage(
                    Some(anchor.clone()),
                    CoverageStatus::Missing,
                    CoverageReason::FormulaUnavailable,
                );
                None
            }
        };
        let table_id = output.tables.len() as u32;
        let mut cells = BTreeMap::new();
        let (start_row, start_column) = range.start().unwrap_or((0, 0));
        for (row_index, row) in range.rows().enumerate() {
            request.check_cancelled()?;
            for (column_index, value) in row.iter().enumerate() {
                let row = start_row + row_index as u32 + 1;
                let column = start_column + column_index as u32 + 1;
                let source = raw.remove(&(name.clone(), row, column));
                let mut cell = cell_from_data(row, column, value);
                if let Some(source) = source {
                    cell.raw = source.raw;
                    cell.formula = source.formula;
                    if let Some(value) = source.value {
                        // Styles identify Excel date serials; the raw numeric lexeme supplements, not replaces, that meaning.
                        if !matches!(cell.value, CellValue::DateTime { .. }) {
                            cell.value = value;
                        }
                    }
                    cell.row_span = source.row_span.max(1);
                    cell.column_span = source.column_span.max(1);
                }
                if cell.formula.is_none() {
                    cell.formula = formulas
                        .as_ref()
                        .and_then(|range| range.get_value((row - 1, column - 1)))
                        .filter(|formula| !formula.is_empty())
                        .cloned();
                }
                cells.insert((row, column), cell);
            }
        }
        if let Some(formulas) = &formulas {
            let (start_row, start_column) = formulas.start().unwrap_or((0, 0));
            for (relative_row, relative_column, formula) in formulas.cells() {
                if formula.is_empty() {
                    continue;
                }
                let row = start_row + relative_row as u32 + 1;
                let column = start_column + relative_column as u32 + 1;
                let cell = cells
                    .entry((row, column))
                    .or_insert_with(|| cell_from_data(row, column, &Data::Empty));
                if cell.formula.as_deref().is_none_or(str::is_empty) {
                    cell.formula = Some(formula.clone());
                }
            }
        }
        if let Sheets::Xls(workbook) = &workbook {
            for merged in workbook.worksheet_merge_cells(&name).unwrap_or_default() {
                let row = merged.start.0 + 1;
                let column = merged.start.1 + 1;
                let cell = cells
                    .entry((row, column))
                    .or_insert_with(|| cell_from_data(row, column, &Data::Empty));
                cell.row_span = merged.end.0.saturating_sub(merged.start.0) + 1;
                cell.column_span = merged.end.1.saturating_sub(merged.start.1) + 1;
            }
        }
        // Keep explicit blanks, formulas without cached values and merge origins outside calamine's used range.
        let remaining = raw
            .keys()
            .filter(|(sheet, _, _)| sheet == &name)
            .cloned()
            .collect::<Vec<_>>();
        for key @ (_, row, column) in remaining {
            let source = raw.remove(&key).unwrap();
            cells.insert(
                (row, column),
                Cell {
                    row,
                    column,
                    row_span: source.row_span.max(1),
                    column_span: source.column_span.max(1),
                    raw: source.raw,
                    formula: source.formula,
                    value: source.value.unwrap_or(CellValue::Missing),
                },
            );
        }
        let merges = cells
            .values()
            .filter(|cell| cell.row_span > 1 || cell.column_span > 1)
            .map(|cell| (cell.row, cell.column, cell.row_span, cell.column_span))
            .collect::<Vec<_>>();
        for (row, column, rows, columns) in merges {
            if (rows as usize)
                .saturating_mul(columns as usize)
                .saturating_add(cells.len())
                > 1_000_000
            {
                return Err(ParseFailure::limit("table_cells"));
            }
            let last_row = row
                .checked_add(rows)
                .ok_or_else(|| ParseFailure::limit("table_rows"))?;
            let last_column = column
                .checked_add(columns)
                .ok_or_else(|| ParseFailure::limit("table_columns"))?;
            for covered_row in row..last_row {
                for covered_column in column..last_column {
                    if (covered_row, covered_column) == (row, column) {
                        continue;
                    }
                    let cell = cells
                        .entry((covered_row, covered_column))
                        .or_insert_with(|| {
                            cell_from_data(covered_row, covered_column, &Data::Empty)
                        });
                    cell.value = CellValue::Covered { row, column };
                }
            }
        }
        if cells.len() > 1_000_000 {
            return Err(ParseFailure::limit("table_cells"));
        }
        let mut float_precision = false;
        let mut raw_missing = false;
        for cell in cells.values() {
            float_precision |=
                matches!(cell.value, CellValue::Float(_) | CellValue::DateTime { .. });
            raw_missing |= cell.raw.is_none()
                && !matches!(cell.value, CellValue::Missing | CellValue::Covered { .. });
            output.source_map.push(SourceMapEntry {
                target: Target::Cell {
                    table_id,
                    row: cell.row,
                    column: cell.column,
                },
                anchor: Anchor::Sheet {
                    sheet: name.clone(),
                    row: cell.row,
                    column: cell.column,
                },
            });
        }
        if float_precision {
            output.coverage(
                Some(anchor.clone()),
                CoverageStatus::Missing,
                CoverageReason::BinaryFloatPrecision,
            );
        }
        if raw_missing {
            output.coverage(
                Some(anchor.clone()),
                CoverageStatus::Missing,
                CoverageReason::RawValueUnavailable,
            );
        }
        output.tables.push(Table {
            id: table_id,
            name: Some(name),
            header_rows: 0,
            cells: cells.into_values().collect(),
        });
        output.push_block(
            None,
            BlockKind::Table { table_id },
            String::new(),
            Some(anchor.clone()),
        );
        output.coverage(
            Some(anchor),
            CoverageStatus::Processed,
            CoverageReason::Parsed,
        );
    }
    if request.bytes.starts_with(b"PK") {
        let assets = crate::assets::office(request)?;
        output.assets = assets.assets;
        output.source_map.extend(assets.source_map);
        output.coverage.entries.extend(assets.coverage.entries);
        output.diagnostics.extend(assets.diagnostics);
    }
    output.coverage(
        None,
        CoverageStatus::Missing,
        CoverageReason::UpstreamRecoveryNotReported,
    );
    output
        .metadata
        .insert("format_parser".into(), "calamine/0.34.0+source-xml".into());
    Ok(output)
}

fn cell_from_data(row: u32, column: u32, value: &Data) -> Cell {
    let value = match value {
        Data::Empty => CellValue::Missing,
        Data::Int(value) => CellValue::Integer(value.to_string()),
        Data::Float(value) => CellValue::Float(*value),
        Data::String(value) => CellValue::Text(value.clone()),
        Data::Bool(value) => CellValue::Boolean(*value),
        Data::DateTime(value) => CellValue::DateTime {
            serial: value.as_f64(),
            display: value.to_string(),
        },
        Data::DateTimeIso(value) => CellValue::DateTimeIso(value.clone()),
        Data::DurationIso(value) => CellValue::DurationIso(value.clone()),
        Data::Error(value) => CellValue::Error(value.to_string()),
    };
    Cell {
        row,
        column,
        row_span: 1,
        column_span: 1,
        raw: None,
        value,
        formula: None,
    }
}

pub(crate) fn numeric(raw: &str) -> CellValue {
    if raw.parse::<serde_json::Number>().is_ok() {
        if !raw.contains(['.', 'e', 'E']) {
            CellValue::Integer(raw.to_owned())
        } else {
            CellValue::Decimal(raw.to_owned())
        }
    } else {
        CellValue::Text(raw.to_owned())
    }
}

fn coordinate(address: &str) -> Option<(u32, u32)> {
    let mut column = 0_u32;
    let mut split = 0;
    for (index, byte) in address.bytes().enumerate() {
        if !byte.is_ascii_alphabetic() {
            split = index;
            break;
        }
        column = column
            .checked_mul(26)?
            .checked_add((byte.to_ascii_uppercase() - b'A' + 1) as u32)?;
    }
    let row = address.get(split..)?.parse().ok()?;
    (column > 0 && row > 0).then_some((row, column))
}

fn xlsx_raw(bytes: &[u8]) -> Result<RawCells, ParseFailure> {
    let mut archive = archive::open(bytes)?;
    let workbook = archive::xml(&archive::read(&mut archive, "xl/workbook.xml")?)?;
    let relationships = archive::xml(&archive::read(&mut archive, "xl/_rels/workbook.xml.rels")?)?;
    let shared = if archive
        .file_names()
        .any(|name| name == "xl/sharedStrings.xml")
    {
        archive::xml(&archive::read(&mut archive, "xl/sharedStrings.xml")?)?
            .descendants("si")
            .map(|item| {
                item.descendants("t")
                    .map(|text| text.text.clone())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let mut output = BTreeMap::new();
    for sheet in workbook.descendants("sheet") {
        let Some(name) = sheet.attribute("name") else {
            continue;
        };
        let Some(id) = sheet.attribute("id") else {
            continue;
        };
        let Some(target) = relationships
            .descendants("Relationship")
            .find(|relationship| relationship.attribute("Id") == Some(id))
            .and_then(|relationship| relationship.attribute("Target"))
        else {
            continue;
        };
        let part = archive::resolve_part("xl/workbook.xml", target)
            .ok_or_else(|| ParseFailure::new(FailureKind::Corrupt))?;
        let worksheet = archive::xml(&archive::read(&mut archive, &part)?)?;
        for cell in worksheet.descendants("c") {
            let Some((row, column)) = cell.attribute("r").and_then(coordinate) else {
                continue;
            };
            let raw = cell.child("v").map(|value| value.text.clone());
            let value = match (cell.attribute("t"), raw.as_deref()) {
                (Some("s"), Some(index)) => index
                    .parse::<usize>()
                    .ok()
                    .and_then(|index| shared.get(index))
                    .cloned()
                    .map(CellValue::Text),
                (Some("inlineStr"), _) => Some(CellValue::Text(
                    cell.child("is")
                        .map(|value| {
                            value
                                .descendants("t")
                                .map(|text| text.text.clone())
                                .collect()
                        })
                        .unwrap_or_default(),
                )),
                (Some("b"), Some(value)) => Some(CellValue::Boolean(value == "1")),
                (Some("e"), Some(value)) => Some(CellValue::Error(value.into())),
                (Some("str"), Some(value)) => Some(CellValue::Text(value.into())),
                (Some("d"), Some(value)) => Some(CellValue::DateTimeIso(value.into())),
                (None | Some("n"), Some(value)) => Some(numeric(value)),
                (_, None) => Some(CellValue::Missing),
                _ => None,
            };
            output.insert(
                (name.into(), row, column),
                RawCell {
                    raw,
                    value,
                    formula: cell.child("f").map(|value| value.text.clone()),
                    row_span: 1,
                    column_span: 1,
                },
            );
        }
        for merged in worksheet.descendants("mergeCell") {
            if let Some((start, end)) = merged
                .attribute("ref")
                .and_then(|value| value.split_once(':'))
            {
                if let (Some((row, column)), Some((last_row, last_column))) =
                    (coordinate(start), coordinate(end))
                {
                    let cell = output.entry((name.into(), row, column)).or_default();
                    cell.row_span = last_row.saturating_sub(row) + 1;
                    cell.column_span = last_column.saturating_sub(column) + 1;
                }
            }
        }
    }
    Ok(output)
}

fn ods_raw(bytes: &[u8]) -> Result<RawCells, ParseFailure> {
    let mut archive = archive::open(bytes)?;
    let document = archive::xml(&archive::read(&mut archive, "content.xml")?)?;
    let mut output = BTreeMap::new();
    for table in document.descendants("table") {
        let name = table.attribute("name").unwrap_or("");
        let mut row = 1_u32;
        for source_row in table.descendants("table-row") {
            let repeated_rows = repeat(source_row.attribute("number-rows-repeated"))?;
            let mut column = 1_u32;
            for source_cell in &source_row.children {
                if !matches!(
                    source_cell.name.as_str(),
                    "table-cell" | "covered-table-cell"
                ) {
                    continue;
                }
                let repeated_columns = repeat(source_cell.attribute("number-columns-repeated"))?;
                if output
                    .len()
                    .saturating_add(repeated_rows as usize * repeated_columns as usize)
                    > 1_000_000
                {
                    return Err(ParseFailure::limit("table_cells"));
                }
                let raw = source_cell
                    .attribute("value")
                    .or_else(|| source_cell.attribute("boolean-value"))
                    .or_else(|| source_cell.attribute("date-value"))
                    .or_else(|| source_cell.attribute("time-value"))
                    .map(str::to_owned);
                let value = match source_cell.attribute("value-type") {
                    Some("float" | "currency" | "percentage") => raw.as_deref().map(numeric),
                    Some("boolean") => raw
                        .as_deref()
                        .map(|value| CellValue::Boolean(value == "true")),
                    Some("date") => raw.clone().map(CellValue::DateTimeIso),
                    Some("time") => raw.clone().map(CellValue::DurationIso),
                    Some("string") => Some(CellValue::Text(
                        source_cell
                            .attribute("string-value")
                            .map(str::to_owned)
                            .unwrap_or_else(|| source_cell.text_content()),
                    )),
                    Some("void") => Some(CellValue::Null),
                    _ => Some(CellValue::Missing),
                };
                for row_offset in 0..repeated_rows {
                    for column_offset in 0..repeated_columns {
                        output.insert(
                            (name.into(), row + row_offset, column + column_offset),
                            RawCell {
                                raw: raw.clone(),
                                value: value.clone(),
                                formula: source_cell.attribute("formula").map(str::to_owned),
                                row_span: repeat(source_cell.attribute("number-rows-spanned"))?,
                                column_span: repeat(
                                    source_cell.attribute("number-columns-spanned"),
                                )?,
                            },
                        );
                    }
                }
                column = column
                    .checked_add(repeated_columns)
                    .ok_or_else(|| ParseFailure::limit("table_columns"))?;
            }
            row = row
                .checked_add(repeated_rows)
                .ok_or_else(|| ParseFailure::limit("table_rows"))?;
        }
    }
    Ok(output)
}

fn repeat(value: Option<&str>) -> Result<u32, ParseFailure> {
    let count = match value {
        Some(value) => value
            .parse()
            .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?,
        None => 1,
    };
    if count == 0 || count > 1_000_000 {
        return Err(ParseFailure::limit("table_repeat"));
    }
    Ok(count)
}
