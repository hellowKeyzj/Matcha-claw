use std::collections::BTreeSet;
use std::fmt::Write as _;

use world_protocol::{
    compiler::{CompileFailure, CompileTarget, TypedIr},
    definitions::DefinitionBody,
    expression::Parameter,
    failure::FieldPath,
    value::ValueType,
};

pub(super) fn typescript(ir: &TypedIr) -> Result<String, CompileFailure> {
    let mut source = String::from("// Generated from a checked, revision-locked World model. Decimal amounts stay exact text.\n");
    source.push_str("export type DefinitionRef = { world: { tenantId: string; worldId: string }; id: string; revision: string };\n");
    source.push_str("export type QueryArgument = { parameterId: string; value: WireValue };\n");
    source.push_str("export type WorldRef = DefinitionRef['world'];\nexport type QueryOptions = { releaseId: string; readMode: { kind: 'authoritative' } | { kind: 'projected'; maxLag: string } | { kind: 'after'; receiptId: string }; page: { limit: number; cursor?: string }; validAt?: string; knownAt?: string };\n");
    source.push_str("export type WireValue = { kind: 'null' } | { kind: 'boolean'; value: boolean } | { kind: 'integer'; value: string } | { kind: 'decimal'; value: string } | { kind: 'text'; value: string } | { kind: 'money'; amount: string; currency: string } | { kind: 'quantity'; amount: string; unit: { code: string; dimension: string } } | { kind: 'timestamp'; value: string } | { kind: 'date'; value: string; calendar: string } | { kind: 'duration'; milliseconds: string } | { kind: 'object' | 'relation'; id: string } | { kind: 'list'; items: WireValue[] } | { kind: 'record'; fields: Record<string, WireValue> };\n");
    let mut names = BTreeSet::new();
    for definition in &ir.definitions {
        let name = identifier(definition.reference.id.as_str());
        if !names.insert(name.clone()) { return Err(invalid(CompileTarget::TypeScriptSdk, &name)); }
        writeln!(source, "export const {name}_ref = {} satisfies DefinitionRef;", text(&definition.reference)?).map_err(|_| CompileFailure::InternalFault)?;
        match &definition.body {
            DefinitionBody::ObjectType(object) => {
                writeln!(source, "export interface {name}_fields {{").map_err(|_| CompileFailure::InternalFault)?;
                for property in &object.properties {
                    let property = ir.definitions.iter().find(|entry| &entry.reference == property).ok_or_else(|| invalid(CompileTarget::TypeScriptSdk, &name))?;
                    let DefinitionBody::Property(property) = &property.body else { return Err(invalid(CompileTarget::TypeScriptSdk, &name)); };
                    let mut value_type = ts_type(&property.value_type)?;
                    if property.cardinality.maximum != Some(1) { value_type = format!("{{ kind: 'list'; items: ({value_type})[] }}"); }
                    if property.nullable { value_type.push_str(" | { kind: 'null' }"); }
                    writeln!(source, "  {}{}: {value_type};", text(&property.name)?, if property.cardinality.minimum == 0 { "?" } else { "" }).map_err(|_| CompileFailure::InternalFault)?;
                }
                source.push_str("}\n");
            }
            DefinitionBody::ConceptView(view) => {
                ts_parameters(&mut source, &name, &view.query.parameters)?;
                writeln!(source, "export const {name}_query = {} as const;", text(&view.query)?).map_err(|_| CompileFailure::InternalFault)?;
                writeln!(source, "export function {name}_request(world: WorldRef, params: {name}_params, options: QueryOptions) {{ return {{ world, query: {{ kind: 'objects' as const, request: {{ world, query: {name}_query, arguments: {name}_arguments(params), ...options }} }} }}; }}").map_err(|_| CompileFailure::InternalFault)?;
            }
            DefinitionBody::ActionContract(action) => {
                ts_parameters(&mut source, &name, &action.parameters)?;
                writeln!(source, "export function {name}_proposal(world: WorldRef, requestId: string, params: {name}_params, targets: ({{ kind: 'object' | 'relation'; id: string }})[], basis: string[]) {{ return {{ world, requestId, command: {{ kind: 'action_propose' as const, request: {{ world, action: {name}_ref, arguments: {name}_arguments(params), targets, basis }} }} }}; }}").map_err(|_| CompileFailure::InternalFault)?;
            },
            DefinitionBody::Function(function) => ts_parameters(&mut source, &name, &function.parameters)?,
            _ => {}
        }
    }
    source.push_str("export async function sendWorldRequest<T>(endpoint: string, request: object, fetcher: typeof fetch = fetch): Promise<T> { const response = await fetcher(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }); if (!response.ok) throw new Error('World request failed: ' + response.status); return await response.json() as T; }\n");
    Ok(source)
}

fn ts_parameters(source: &mut String, name: &str, parameters: &[Parameter]) -> Result<(), CompileFailure> {
    writeln!(source, "export interface {name}_params {{").map_err(|_| CompileFailure::InternalFault)?;
    for parameter in parameters {
        let mut value_type = ts_type(&parameter.value_type)?;
        if parameter.nullable { value_type.push_str(" | { kind: 'null' }"); }
        writeln!(source, "  {}{}: {value_type};", text(parameter.id.as_str())?, if parameter.optional { "?" } else { "" }).map_err(|_| CompileFailure::InternalFault)?;
    }
    writeln!(source, "}}\nexport function {name}_arguments(params: {name}_params): QueryArgument[] {{\n  const result: QueryArgument[] = [];").map_err(|_| CompileFailure::InternalFault)?;
    for parameter in parameters {
        let key = text(parameter.id.as_str())?;
        writeln!(source, "  {}result.push({{ parameterId: {key}, value: params[{key}]{} }});",
            if parameter.optional { format!("if (params[{key}] !== undefined) ") } else { String::new() },
            if parameter.optional { "!" } else { "" }).map_err(|_| CompileFailure::InternalFault)?;
    }
    source.push_str("  return result;\n}\n");
    Ok(())
}

fn ts_type(value_type: &ValueType) -> Result<String, CompileFailure> {
    Ok(match value_type {
        ValueType::Null => "{ kind: 'null' }".into(),
        ValueType::Boolean => "{ kind: 'boolean'; value: boolean }".into(),
        ValueType::Integer => "{ kind: 'integer'; value: string }".into(),
        ValueType::Decimal { .. } => "{ kind: 'decimal'; value: string }".into(),
        ValueType::Text { .. } => "{ kind: 'text'; value: string }".into(),
        ValueType::Money { currency } => format!("{{ kind: 'money'; amount: string; currency: {} }}", text(currency.as_str())?),
        ValueType::Quantity { unit } => format!("{{ kind: 'quantity'; amount: string; unit: {{ code: {}; dimension: {} }} }}", text(&unit.code)?, text(&unit.dimension)?),
        ValueType::Timestamp { .. } => "{ kind: 'timestamp'; value: string }".into(),
        ValueType::Date { calendar } => format!("{{ kind: 'date'; value: string; calendar: {} }}", text(calendar)?),
        ValueType::Duration => "{ kind: 'duration'; milliseconds: string }".into(),
        ValueType::Object { .. } => "{ kind: 'object'; id: string }".into(),
        ValueType::Relation { .. } => "{ kind: 'relation'; id: string }".into(),
        ValueType::List { element, .. } => format!("{{ kind: 'list'; items: ({})[] }}", ts_type(element)?),
        ValueType::Record { fields } => {
            let fields = fields.iter().map(|field| Ok(format!("{}{}: {}{}", text(&field.name)?, if field.optional { "?" } else { "" },
                ts_type(&field.value_type)?, if field.nullable { " | { kind: 'null' }" } else { "" }))).collect::<Result<Vec<_>, CompileFailure>>()?;
            format!("{{ kind: 'record'; fields: {{ {} }} }}", fields.join("; "))
        }
    })
}

pub(super) fn rust(ir: &TypedIr) -> Result<String, CompileFailure> {
    let mut source = String::from("// Generated; requires world-protocol and serde_json. No runtime or publication authority.\nuse world_protocol::{ids::{DefinitionRef, ReleaseId, RequestId, ReadReceiptId}, query::{QueryArgument, QueryIr, QueryRequest, ReadMode, PageRequest}, value::Value, api::{QueryEnvelope, WorldQuery, CommandEnvelope, WorldCommand}, actions::ActionProposalRequest, identity::SubjectRef};\n");
    let mut names = BTreeSet::new();
    for definition in &ir.definitions {
        let name = identifier(definition.reference.id.as_str());
        if !names.insert(name.clone()) { return Err(invalid(CompileTarget::RustSdk, &name)); }
        let reference = text(&definition.reference)?;
        writeln!(source, "pub fn {name}_reference() -> Result<DefinitionRef, serde_json::Error> {{ serde_json::from_str({reference:?}) }}").map_err(|_| CompileFailure::InternalFault)?;
        let parameters = match &definition.body {
            DefinitionBody::ConceptView(view) => {
                let query = text(&view.query)?;
                writeln!(source, "pub fn {name}_query() -> Result<QueryIr, serde_json::Error> {{ serde_json::from_str({query:?}) }}").map_err(|_| CompileFailure::InternalFault)?;
                writeln!(source, "pub fn {name}_request(arguments: Vec<QueryArgument>, release_id: ReleaseId, read_mode: ReadMode, page: PageRequest) -> Result<QueryEnvelope, serde_json::Error> {{ let world = {name}_reference()?.world; Ok(QueryEnvelope {{ world: world.clone(), query: WorldQuery::Objects(QueryRequest {{ world, branch_id: None, release_id: Some(release_id), query: {name}_query()?, arguments, read_mode, valid_at: None, known_at: None, page }}) }}) }}").map_err(|_| CompileFailure::InternalFault)?;
                Some(&view.query.parameters)
            }
            DefinitionBody::ActionContract(action) => {
                writeln!(source, "pub fn {name}_proposal(request_id: RequestId, arguments: Vec<QueryArgument>, targets: Vec<SubjectRef>, basis: Vec<ReadReceiptId>) -> Result<CommandEnvelope, serde_json::Error> {{ let action = {name}_reference()?; let world = action.world.clone(); Ok(CommandEnvelope {{ world: world.clone(), request_id, command: WorldCommand::ActionPropose(ActionProposalRequest {{ world, branch_id: None, action, arguments, targets, basis }}) }}) }}").map_err(|_| CompileFailure::InternalFault)?;
                Some(&action.parameters)
            },
            DefinitionBody::Function(function) => Some(&function.parameters),
            _ => None,
        };
        if let Some(parameters) = parameters {
            writeln!(source, "pub fn {name}_arguments(values: Vec<(String, Value)>) -> Result<Vec<QueryArgument>, &'static str> {{\n  let mut result = Vec::new();\n  let mut seen = std::collections::BTreeSet::new();\n  for (name, value) in values {{\n    if !seen.insert(name.clone()) {{ return Err(\"duplicate parameter\"); }}\n    match name.as_str() {{").map_err(|_| CompileFailure::InternalFault)?;
            for parameter in parameters {
                writeln!(source, "      {:?} => {{}},", parameter.id.as_str()).map_err(|_| CompileFailure::InternalFault)?;
            }
            source.push_str("      _ => return Err(\"unknown parameter\"),\n    }\n    result.push(QueryArgument { parameter_id: name.parse().map_err(|_| \"invalid parameter\")?, value });\n  }\n");
            for parameter in parameters.iter().filter(|parameter| !parameter.optional) {
                writeln!(source, "  if !seen.contains({:?}) {{ return Err(\"missing parameter\"); }}", parameter.id.as_str()).map_err(|_| CompileFailure::InternalFault)?;
            }
            source.push_str("  Ok(result)\n}\n");
        }
    }
    Ok(source)
}

fn identifier(value: &str) -> String {
    let mut result = String::from("d_");
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() { result.push(byte as char); }
        else { let _ = write!(result, "_{byte:02x}"); }
    }
    result
}

fn text(value: &(impl serde::Serialize + ?Sized)) -> Result<String, CompileFailure> {
    serde_json::to_string(value).map_err(|_| CompileFailure::InternalFault)
}

fn invalid(target: CompileTarget, name: &str) -> CompileFailure {
    CompileFailure::GeneratedSdkInvalid { target, field: FieldPath(vec![name.into()]) }
}
