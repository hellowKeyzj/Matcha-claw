use base64::{
    Engine, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use chrono::{Datelike, Duration, NaiveDate};

use super::Scalar;

pub(super) fn resolve(value: &str, tag: Option<&str>) -> Option<Result<Scalar, ()>> {
    match tag? {
        "tag:yaml.org,2002:binary" => {
            // Node's Buffer decoder ignores non-alphabet characters and accepts base64url.
            let mut text: String = value
                .chars()
                .take_while(|ch| *ch != '=')
                .filter_map(|ch| match ch {
                    '-' => Some('+'),
                    '_' => Some('/'),
                    ch if ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/') => Some(ch),
                    _ => None,
                })
                .collect();
            if text.len() % 4 == 1 {
                text.pop();
            }
            let decoder = GeneralPurpose::new(
                &alphabet::STANDARD,
                GeneralPurposeConfig::new()
                    .with_decode_padding_mode(DecodePaddingMode::Indifferent)
                    .with_decode_allow_trailing_bits(true),
            );
            Some(decoder.decode(text).map(Scalar::Binary).map_err(|_| ()))
        }
        "tag:yaml.org,2002:timestamp" => Some(timestamp(value).map(Scalar::Timestamp)),
        "tag:yaml.org,2002:merge" => Some(Ok(Scalar::Merge)),
        _ => None,
    }
}

fn digits<'a>(text: &mut &'a str, min: usize, max: usize) -> Result<i64, ()> {
    let len = text.bytes().take_while(u8::is_ascii_digit).count();
    if len < min || len > max {
        return Err(());
    }
    let value = text[..len].parse().map_err(|_| ())?;
    *text = &text[len..];
    Ok(value)
}

fn take(text: &mut &str, prefix: &str) -> Result<(), ()> {
    *text = text.strip_prefix(prefix).ok_or(())?;
    Ok(())
}

fn timestamp(mut text: &str) -> Result<String, ()> {
    let mut year = digits(&mut text, 4, 4)?;
    take(&mut text, "-")?;
    let month = digits(&mut text, 1, 2)?;
    take(&mut text, "-")?;
    let day = digits(&mut text, 1, 2)?;
    let (mut hour, mut minute, mut second, mut millis, mut offset) = (0, 0, 0, 0, 0);
    if !text.is_empty() {
        if text.starts_with(['t', 'T']) {
            text = &text[1..];
        } else {
            let rest = text.trim_start_matches([' ', '\t']);
            if rest == text {
                return Err(());
            }
            text = rest;
        }
        hour = digits(&mut text, 1, 2)?;
        take(&mut text, ":")?;
        minute = digits(&mut text, 1, 2)?;
        take(&mut text, ":")?;
        second = digits(&mut text, 1, 2)?;
        if let Some(rest) = text.strip_prefix('.') {
            let len = rest.bytes().take_while(u8::is_ascii_digit).count();
            if len == 0 {
                return Err(());
            }
            let fraction = &rest[..len];
            millis = fraction
                .bytes()
                .take(3)
                .fold(0, |n, digit| n * 10 + i64::from(digit - b'0'));
            millis *= 10i64.pow(3 - len.min(3) as u32);
            text = &rest[len..];
        }
        if !text.is_empty() {
            text = text.trim_start_matches([' ', '\t']);
            if text == "Z" {
                text = "";
            } else {
                let sign = match text.as_bytes().first() {
                    Some(b'+') => 1,
                    Some(b'-') => -1,
                    _ => return Err(()),
                };
                text = &text[1..];
                let hours = digits(&mut text, 1, 2)?;
                if hours > 29 {
                    return Err(());
                }
                let zone = if text.starts_with(':') {
                    text = &text[1..];
                    hours * 60 + digits(&mut text, 2, 2)?
                } else {
                    hours
                };
                // yaml's resolver treats a sexagesimal magnitude below 30 as hours.
                offset = sign * if zone < 30 { zone * 60 } else { zone };
            }
        }
    }
    if !text.is_empty() {
        return Err(());
    }
    if year < 100 {
        year += 1900;
    }
    let months = year * 12 + month - 1;
    let date = NaiveDate::from_ymd_opt(
        months.div_euclid(12) as i32,
        months.rem_euclid(12) as u32 + 1,
        1,
    )
    .ok_or(())?
    .and_hms_opt(0, 0, 0)
    .ok_or(())?
        + Duration::days(day - 1)
        + Duration::hours(hour)
        + Duration::minutes(minute - offset)
        + Duration::seconds(second)
        + Duration::milliseconds(millis);
    let year = date.year();
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    Ok(format!("{year}{}", date.format("-%m-%dT%H:%M:%S%.3fZ")))
}
