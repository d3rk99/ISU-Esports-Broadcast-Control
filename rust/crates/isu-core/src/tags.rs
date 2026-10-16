//! Gamertag matching: src/overwatch-ocr-panel.js foldTag / editDistance / tagSimilarity / NAME_MATCH.
use unicode_normalization::UnicodeNormalization;

/// NAME_MATCH (overwatch-ocr-panel.js): a roster player matches an OCR row at >= 90%.
pub const NAME_MATCH: f64 = 0.9;

/// foldTag: NFD, strip combining marks, upper case, O->0, I/L/| ->1, S->5, B->8, drop spaces _ . - #.
pub fn fold_tag(value: &str) -> Vec<char> {
    value
        .nfd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .flat_map(|c| c.to_uppercase())
        .filter_map(|c| match c {
            'O' => Some('0'),
            'I' | 'L' | '|' => Some('1'),
            'S' => Some('5'),
            'B' => Some('8'),
            c if c.is_whitespace() || matches!(c, '_' | '.' | '-' | '#') => None,
            c => Some(c),
        })
        .collect()
}

/// editDistance: Levenshtein, one row. Works on UTF-16 code units in JS; on chars here.
/// Same result for every BMP character (all real gamertags); see tests.
pub fn edit_distance(a: &[char], b: &[char]) -> usize {
    if a == b {
        return 0;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut diag = prev[0];
        prev[0] = i;
        for j in 1..=b.len() {
            let up = prev[j];
            prev[j] = (prev[j] + 1).min(prev[j - 1] + 1).min(diag + usize::from(a[i - 1] != b[j - 1]));
            diag = up;
        }
    }
    prev[b.len()]
}

/// tagSimilarity: 1 - editDistance / longer length, on folded tags. 0 when either is empty.
pub fn tag_similarity(a: &str, b: &str) -> f64 {
    let x = fold_tag(a);
    let y = fold_tag(b);
    if x.is_empty() || y.is_empty() {
        return 0.0;
    }
    1.0 - edit_distance(&x, &y) as f64 / x.len().max(y.len()) as f64
}
