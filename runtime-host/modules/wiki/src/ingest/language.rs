use std::sync::LazyLock;

use regex::{Regex, RegexSet};

pub(super) fn detect_language(text: &str) -> String {
    const SCRIPTS: [&str; 24] = [
        "Chinese",
        "Japanese",
        "Korean",
        "Arabic",
        "Hebrew",
        "Thai",
        "Hindi",
        "Bengali",
        "Tamil",
        "Telugu",
        "Kannada",
        "Malayalam",
        "Gujarati",
        "Punjabi",
        "Burmese",
        "Khmer",
        "Lao",
        "Georgian",
        "Armenian",
        "Amharic",
        "Tibetan",
        "Sinhala",
        "Russian",
        "Greek",
    ];
    let mut counts = [(0usize, usize::MAX); SCRIPTS.len()];
    for (position, ch) in text.chars().enumerate() {
        let script = match ch as u32 {
            0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x20000..=0x2A6DF | 0xF900..=0xFAFF => 0,
            0x3040..=0x309F | 0x30A0..=0x30FF | 0x31F0..=0x31FF | 0xFF65..=0xFF9F => 1,
            0xAC00..=0xD7AF | 0x1100..=0x11FF | 0x3130..=0x318F => 2,
            0x0600..=0x06FF
            | 0x0750..=0x077F
            | 0x08A0..=0x08FF
            | 0xFB50..=0xFDFF
            | 0xFE70..=0xFEFF => 3,
            0x0590..=0x05FF | 0xFB1D..=0xFB4F => 4,
            0x0E00..=0x0E7F => 5,
            0x0900..=0x097F => 6,
            0x0980..=0x09FF => 7,
            0x0B80..=0x0BFF => 8,
            0x0C00..=0x0C7F => 9,
            0x0C80..=0x0CFF => 10,
            0x0D00..=0x0D7F => 11,
            0x0A80..=0x0AFF => 12,
            0x0A00..=0x0A7F => 13,
            0x1000..=0x109F => 14,
            0x1780..=0x17FF => 15,
            0x0E80..=0x0EFF => 16,
            0x10A0..=0x10FF | 0x2D00..=0x2D2F => 17,
            0x0530..=0x058F => 18,
            0x1200..=0x137F => 19,
            0x0F00..=0x0FFF => 20,
            0x0D80..=0x0DFF => 21,
            0x0400..=0x04FF | 0x0500..=0x052F => 22,
            0x0370..=0x03FF | 0x1F00..=0x1FFF => 23,
            _ => continue,
        };
        let (count, first) = &mut counts[script];
        if *count == 0 {
            *first = position;
        }
        *count += 1;
    }
    if counts[0].0 > 0 && counts[1].0 > 0 {
        return "Japanese".to_owned();
    }
    let dominant = (0..SCRIPTS.len())
        .max_by_key(|&script| {
            let (count, first) = counts[script];
            (count, std::cmp::Reverse(first))
        })
        .unwrap();
    if counts[dominant].0 >= 2 {
        return if dominant == 3 {
            detect_arabic_language(text)
        } else {
            SCRIPTS[dominant]
        }
        .to_owned();
    }
    detect_latin_language(text).to_owned()
}

fn detect_arabic_language(text: &str) -> &'static str {
    let mut persian_score = 0usize;
    let mut arabic_score = 0usize;
    for ch in text.chars() {
        match ch {
            'پ' | 'چ' | 'ژ' | 'گ' => persian_score += 3,
            'ک' | 'ی' => persian_score += 1,
            'ك' | 'ي' | 'ة' | 'ى' | 'إ' | 'أ' | 'ؤ' | 'ئ' => arabic_score += 1,
            _ => {}
        }
    }
    // JS normalizes separators using General_Category L/N, not Alphabetic/\w.
    static WORDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]+").unwrap());
    let mut persian_words = 0u16;
    let mut arabic_words = 0u16;
    for word in WORDS.find_iter(text) {
        match word.as_str() {
            "این" => persian_words |= 1 << 0,
            "است" => persian_words |= 1 << 1,
            "که" => persian_words |= 1 << 2,
            "برای" => persian_words |= 1 << 3,
            "های" => persian_words |= 1 << 4,
            "را" => persian_words |= 1 << 5,
            "در" => persian_words |= 1 << 6,
            "به" => persian_words |= 1 << 7,
            "از" => persian_words |= 1 << 8,
            "می" => persian_words |= 1 << 9,
            "یک" => persian_words |= 1 << 10,
            "ال" => arabic_words |= 1 << 0,
            "في" => arabic_words |= 1 << 1,
            "من" => arabic_words |= 1 << 2,
            "على" => arabic_words |= 1 << 3,
            "هذا" => arabic_words |= 1 << 4,
            "هذه" => arabic_words |= 1 << 5,
            "إلى" => arabic_words |= 1 << 6,
            "التي" => arabic_words |= 1 << 7,
            "الذي" => arabic_words |= 1 << 8,
            "كان" => arabic_words |= 1 << 9,
            _ => {}
        }
    }
    persian_score += 2 * persian_words.count_ones() as usize;
    arabic_score += 2 * arabic_words.count_ones() as usize;
    if persian_score >= 3 && persian_score > arabic_score {
        "Persian"
    } else {
        "Arabic"
    }
}

fn detect_latin_language(text: &str) -> &'static str {
    let lower = text.to_lowercase();
    // Only the boundaries are ASCII: accented alternatives still match UTF-8.
    // RegexSet finds independent/overlapping signals in one scan, including
    // JS's unusual matches such as `aèb`, `ași`, and `ett` within `että`.
    static SIGNALS: LazyLock<RegexSet> = LazyLock::new(|| {
        RegexSet::new([
            r"[ảạắằẳẵặấầẩẫậđẻẽẹếềểễệỉĩịỏọốồổỗộơớờởỡợủũụưứừửữựỷỹỵ]",
            r"[ğış]",
            r"(?-u:\b)(bir|ve|için|ile|bu|da|de|değil|ama)(?-u:\b)",
            r"[ąćęłńśźż]",
            r"[ěšžřďťňů]",
            r"[ăâîșț]",
            r"(?-u:\b)(și|este|sau|care|pentru)(?-u:\b)",
            r"[őű]",
            r"[äöüß]",
            r"(?-u:\b)und(?-u:\b)",
            r"(?-u:\b)der(?-u:\b)",
            r"(?-u:\b)die(?-u:\b)",
            r"(?-u:\b)das(?-u:\b)",
            r"(?-u:\b)ist(?-u:\b)",
            r"(?-u:\b)nicht(?-u:\b)",
            r"(?-u:\b)ein(?-u:\b)",
            r"(?-u:\b)eine(?-u:\b)",
            r"(?-u:\b)(le|la|les|est|une|des)(?-u:\b)",
            r"[ãõç]",
            r"(?-u:\b)(o|a|os|as|de|do|da|é|em|um|uma|não|que)(?-u:\b)",
            r"(?-u:\b)(el|los|las|del|por)(?-u:\b)|[ñ¿¡]",
            r"(?-u:\b)(il|della|gli|che|è)(?-u:\b)",
            r"(?-u:\b)(het|een|van|dat)(?-u:\b)",
            r"[åäö]",
            r"(?-u:\b)(och|att|det|en|ett|är|för|med)(?-u:\b)",
            r"[åæø]",
            r"(?-u:\b)(og|er|det|en|et|for|med|på)(?-u:\b)",
            r"(?-u:\b)(og|er|det|en|et|til|med|af)(?-u:\b)",
            r"[äö]",
            r"(?-u:\b)(ja|on|ei|se|että|tai|kun|niin)(?-u:\b)",
            r"(?-u:\b)(yang|dari|untuk|dengan|adalah)(?-u:\b)",
            r"(?-u:\b)(na|ya|wa|ni|kwa|katika|hii|hiyo)(?-u:\b)",
        ])
        .unwrap()
    });
    let matches = SIGNALS.matches(&lower);
    let [
        vietnamese,
        turkish_chars,
        turkish_words,
        polish,
        czech,
        romanian_chars,
        romanian_words,
        hungarian,
        german_chars,
        und,
        der,
        die,
        das,
        ist,
        nicht,
        ein,
        eine,
        french,
        portuguese_chars,
        portuguese_words,
        spanish,
        italian,
        dutch,
        swedish_chars,
        swedish_words,
        norwegian_chars,
        norwegian_words,
        danish_words,
        finnish_chars,
        finnish_words,
        indonesian,
        swahili,
    ] = std::array::from_fn(|index| matches.matched(index));
    let german_words = [und, der, die, das, ist, nicht, ein, eine]
        .into_iter()
        .filter(|matched| *matched)
        .count();
    // For French/Spanish/Italian/Dutch/Indonesian the final word set is a
    // subset of the first-stage set, so its match also satisfies that gate.
    if vietnamese {
        "Vietnamese"
    } else if turkish_chars && turkish_words {
        "Turkish"
    } else if polish {
        "Polish"
    } else if czech {
        "Czech"
    } else if romanian_chars && romanian_words {
        "Romanian"
    } else if hungarian {
        "Hungarian"
    } else if german_words >= 2 || (german_chars && german_words >= 1) {
        "German"
    } else if french {
        "French"
    } else if portuguese_chars && portuguese_words {
        "Portuguese"
    } else if spanish {
        "Spanish"
    } else if italian {
        "Italian"
    } else if dutch {
        "Dutch"
    } else if swedish_chars && swedish_words {
        "Swedish"
    } else if norwegian_chars && norwegian_words {
        "Norwegian"
    } else if norwegian_chars && danish_words {
        "Danish"
    } else if finnish_chars && finnish_words {
        "Finnish"
    } else if indonesian {
        "Indonesian"
    } else if swahili {
        "Swahili"
    } else {
        "English"
    }
}
