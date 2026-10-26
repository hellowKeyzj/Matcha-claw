use world_protocol::value::ValueType;

/// Whether every source value fits without conversion, truncation or rounding.
pub(crate) fn type_compatible(source: &ValueType, target: &ValueType) -> bool {
    match (source, target) {
        (
            ValueType::Decimal {
                precision: source_precision,
                scale: source_scale,
            },
            ValueType::Decimal {
                precision: target_precision,
                scale: target_scale,
            },
        ) => {
            *source_precision > 0
                && *target_precision > 0
                && source_scale <= source_precision
                && target_scale <= target_precision
                && source_scale <= target_scale
                && source_precision - source_scale <= target_precision - target_scale
        }
        (ValueType::Text { max_length: source }, ValueType::Text { max_length: target }) => {
            source <= target
        }
        (
            ValueType::List {
                element: source,
                max_items: source_max,
            },
            ValueType::List {
                element: target,
                max_items: target_max,
            },
        ) => source_max <= target_max && type_compatible(source, target),
        (ValueType::Record { fields: source }, ValueType::Record { fields: target }) => {
            source.iter().all(|field| {
                target
                    .iter()
                    .find(|candidate| candidate.name == field.name)
                    .is_some_and(|candidate| {
                        (!field.nullable || candidate.nullable)
                            && (!field.optional || candidate.optional)
                            && type_compatible(&field.value_type, &candidate.value_type)
                    })
            }) && target.iter().all(|field| {
                field.optional
                    || source
                        .iter()
                        .any(|candidate| candidate.name == field.name && !candidate.optional)
            })
        }
        _ => source == target,
    }
}
